"""Always-on usage dashboard for Claude accounts, served on loopback.

A background thread runs the same collection ``ccswap list --json`` runs for the
Claude payload, every ``INTERVAL_S``, and keeps the latest result in memory.
Requests only read that snapshot: a page load never triggers a fetch, so any
number of open tabs cost claude.ai nothing extra.

The server binds ``127.0.0.1``. Reaching it from a phone is the job of
``tailscale serve`` (see ``claude_swap.web_cli``), which proxies a tailnet HTTPS
port to this socket. Nothing here authenticates: the tailnet is the boundary.

Routes: ``/`` is the single-file page (``web_assets/index.html``),
``/api/usage`` is the JSON snapshot, anything else is 404.
"""

from __future__ import annotations

import json
import logging
import sys
import threading
import time
from collections.abc import Callable
from datetime import datetime, timezone
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import resources
from pathlib import Path
from urllib.parse import urlsplit

from claude_swap.fsutil import atomic_write_bytes

DEFAULT_PORT = 4592
HOST = "127.0.0.1"
INTERVAL_S = 20.0
TOOLS_INTERVAL_S = 60.0

_logger = logging.getLogger("claude-swap")

# Content-Security-Policy for the page: everything inline, nothing external,
# and the only fetch is back to this origin.
_PAGE_CSP = (
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
    "connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'"
)


def _iso_utc(epoch_s: float) -> str:
    return (
        datetime.fromtimestamp(epoch_s, tz=timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


class Snapshot:
    """The latest Claude payload and when it was produced. Safe across threads."""

    def __init__(
        self,
        provider: Callable[[], dict | None],
        clock: Callable[[], float] = time.time,
        tools_cache: Path | None = None,
    ) -> None:
        self._provider = provider
        self._tools_cache = tools_cache
        self._clock = clock
        self._lock = threading.Lock()
        self._payload: dict | None = None
        self._generated_at: float | None = None
        self._tools: list[dict] = []
        self._tools_generated_at: float | None = None

    def refresh(self) -> bool:
        """Collect once. A failing collection keeps the previous snapshot."""
        try:
            payload = self._provider()
        except Exception as exc:  # the dashboard must outlive a bad pass
            _logger.warning("web dashboard refresh failed: %s", type(exc).__name__)
            return False
        if payload is None:
            return False
        with self._lock:
            self._payload = payload
            self._generated_at = self._clock()
        return True

    def document(self) -> dict:
        """The ``/api/usage`` body. ``generatedAt`` is null before the first success."""
        from claude_swap.web_order import order_accounts

        with self._lock:
            payload, generated_at = self._payload, self._generated_at
            tools, tools_generated_at = self._tools, self._tools_generated_at
        claude = payload
        rebalance = 0.0
        if isinstance(claude, dict) and isinstance(claude.get("accounts"), list):
            claude = dict(claude)
            strategy = claude.pop("_webOrderStrategy", "consume-first")
            models = claude.pop("_webModels", ())
            windows = claude.pop("_webAccountWindows", ("5h", "7d"))
            rebalance = claude.pop("_webRebalancePct", 0.0)
            claude["accounts"] = order_accounts(
                "claude", claude["accounts"], strategy=strategy,
                models=models, account_windows=windows,
            )
        ordered_tools = []
        for tool in tools:
            if isinstance(tool, dict) and isinstance(tool.get("accounts"), list):
                tool = dict(tool)
                tool["accounts"] = order_accounts(tool.get("tool"), tool["accounts"])
            ordered_tools.append(tool)
        return {
            "generatedAt": _iso_utc(generated_at) if generated_at is not None else None,
            # The page marks a better account only by the margin the engines switch at.
            "autoswitch": {"rebalancePct": rebalance},
            "claude": claude,
            "tools": ordered_tools,
            "toolsGeneratedAt": (
                _iso_utc(tools_generated_at)
                if tools_generated_at is not None else None
            ),
        }

    def set_tools(self, tools: list[dict], generated_at: float | None = None) -> None:
        with self._lock:
            self._tools = tools
            self._tools_generated_at = generated_at if generated_at is not None else time.time()
        if self._tools_cache is not None:
            try:
                self._tools_cache.parent.mkdir(parents=True, exist_ok=True)
                atomic_write_bytes(
                    self._tools_cache,
                    json.dumps({"generatedAt": self._tools_generated_at, "tools": tools}).encode(),
                )
            except OSError:
                _logger.debug("web tools cache not written", exc_info=True)

    def load_tools_cache(self) -> bool:
        """Serve the last collected tools until the first fresh collection lands.

        A restart otherwise shows Claude alone for about a minute: the vendor
        overview takes ~60 s, and on 2026-11-16 every restart dropped Codex, Muse
        and Kiro from the page for that long.
        """
        if self._tools_cache is None:
            return False
        try:
            cached = json.loads(self._tools_cache.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return False
        tools, generated_at = cached.get("tools"), cached.get("generatedAt")
        if not isinstance(tools, list) or not isinstance(generated_at, (int, float)):
            return False
        with self._lock:
            if self._tools_generated_at is None:
                self._tools, self._tools_generated_at = tools, float(generated_at)
        return True


class ToolsPoller(threading.Thread):
    """Refresh the slower vendor overview independently of Claude's live poll."""

    def __init__(self, snapshot: Snapshot, collector=None, interval: float = TOOLS_INTERVAL_S):
        super().__init__(name="ccswap-web-tools-poller", daemon=True)
        self._snapshot = snapshot
        self._collector = collector or _overview_tools
        self._interval = interval
        self._stopping = threading.Event()

    def run(self) -> None:
        while not self._stopping.is_set():
            try:
                self._snapshot.set_tools(self._collector())
            except Exception as exc:
                _logger.warning("web tools refresh failed: %s", type(exc).__name__)
            self._stopping.wait(self._interval)

    def stop(self) -> None:
        self._stopping.set()


class Poller(threading.Thread):
    """Refreshes a :class:`Snapshot` now and then every ``interval`` seconds."""

    def __init__(self, snapshot: Snapshot, interval: float = INTERVAL_S) -> None:
        super().__init__(name="ccswap-web-poller", daemon=True)
        self._snapshot = snapshot
        self._interval = interval
        self._stopping = threading.Event()

    def run(self) -> None:
        from claude_swap.launch_agent import WEB_LABEL
        from claude_swap.service_freshness import FreshnessCheck

        freshness = FreshnessCheck(WEB_LABEL)
        while not self._stopping.is_set():
            self._snapshot.refresh()
            freshness.tick()
            self._stopping.wait(self._interval)

    def stop(self) -> None:
        self._stopping.set()


@lru_cache(maxsize=1)
def index_page() -> bytes:
    return resources.files("claude_swap").joinpath("web_assets/index.html").read_bytes()


class _Handler(BaseHTTPRequestHandler):
    server_version = "ccswap-web"
    sys_version = ""

    def do_GET(self) -> None:  # noqa: N802 - http.server naming
        path = urlsplit(self.path).path
        if path == "/api/usage":
            body = json.dumps(self.server.snapshot.document()).encode()  # type: ignore[attr-defined]
            self._send(200, "application/json; charset=utf-8", body)
        elif path == "/":
            self._send(200, "text/html; charset=utf-8", index_page(), csp=_PAGE_CSP)
        else:
            self._send(404, "text/plain; charset=utf-8", b"Not found\n")

    def _send(self, status: int, content_type: str, body: bytes, csp: str | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if csp:
            self.send_header("Content-Security-Policy", csp)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:  # noqa: A002 - base class name
        _logger.debug("web %s", format % args)


class _Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], snapshot: Snapshot) -> None:
        self.snapshot = snapshot
        super().__init__(address, _Handler)


def make_server(port: int, snapshot: Snapshot, host: str = HOST) -> ThreadingHTTPServer:
    """A bound, not-yet-serving server. ``port=0`` picks a free port."""
    return _Server((host, port), snapshot)


def claude_payload() -> dict:
    """The ``ccswap list --json`` Claude payload, collected the same way."""
    from claude_swap.switcher import ClaudeAccountSwitcher

    switcher = ClaudeAccountSwitcher()
    payload = switcher.list_accounts(json_output=True)
    if not isinstance(payload, dict):
        raise RuntimeError("list_accounts returned no JSON payload")
    from claude_swap.settings import load_settings
    _threshold, models, windows = switcher._poll_policy_inputs()
    settings = load_settings(switcher.backup_dir)
    payload = dict(payload)
    payload["_webOrderStrategy"] = settings.strategy
    payload["_webRebalancePct"] = settings.rebalance_pct
    payload["_webModels"] = models
    payload["_webAccountWindows"] = windows
    return payload


@lru_cache(maxsize=1)
def _web_overview():
    from claude_swap.vendors.overview import Overview

    # Codex and Antigravity are legacy tools: without fetching they only show what
    # another surface already stored, which is nothing on a fresh machine.
    return Overview()


def _overview_tools() -> list[dict]:
    from claude_swap.vendors.overview import overview_json

    overview = _web_overview()
    tools = [tool for tool in overview.tools() if tool != "claude"]
    return overview_json(overview.collect(tools))["tools"]


def serve(port: int = DEFAULT_PORT, provider: Callable[[], dict | None] | None = None) -> int:
    """Run the dashboard in the foreground until interrupted."""
    from claude_swap.paths import get_backup_root

    snapshot = Snapshot(provider or claude_payload, tools_cache=get_backup_root() / "cache" / "web_tools.json")
    snapshot.load_tools_cache()
    server = make_server(port, snapshot)
    poller = Poller(snapshot)
    tools_poller = ToolsPoller(snapshot)
    poller.start()
    tools_poller.start()
    bound = server.server_address[1]
    print(f"ccswap web dashboard on http://{HOST}:{bound}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        poller.stop()
        tools_poller.stop()
        server.server_close()
    return 0

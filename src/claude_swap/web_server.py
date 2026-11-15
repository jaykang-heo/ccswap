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
from urllib.parse import urlsplit

DEFAULT_PORT = 4592
HOST = "127.0.0.1"
INTERVAL_S = 20.0

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
    ) -> None:
        self._provider = provider
        self._clock = clock
        self._lock = threading.Lock()
        self._payload: dict | None = None
        self._generated_at: float | None = None

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
        with self._lock:
            payload, generated_at = self._payload, self._generated_at
        return {
            "generatedAt": _iso_utc(generated_at) if generated_at is not None else None,
            "claude": payload,
        }


class Poller(threading.Thread):
    """Refreshes a :class:`Snapshot` now and then every ``interval`` seconds."""

    def __init__(self, snapshot: Snapshot, interval: float = INTERVAL_S) -> None:
        super().__init__(name="ccswap-web-poller", daemon=True)
        self._snapshot = snapshot
        self._interval = interval
        self._stopping = threading.Event()

    def run(self) -> None:
        while not self._stopping.is_set():
            self._snapshot.refresh()
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

    payload = ClaudeAccountSwitcher().list_accounts(json_output=True)
    if not isinstance(payload, dict):
        raise RuntimeError("list_accounts returned no JSON payload")
    return payload


def serve(port: int = DEFAULT_PORT, provider: Callable[[], dict | None] | None = None) -> int:
    """Run the dashboard in the foreground until interrupted."""
    snapshot = Snapshot(provider or claude_payload)
    server = make_server(port, snapshot)
    poller = Poller(snapshot)
    poller.start()
    bound = server.server_address[1]
    print(f"ccswap web dashboard on http://{HOST}:{bound}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        poller.stop()
        server.server_close()
    return 0

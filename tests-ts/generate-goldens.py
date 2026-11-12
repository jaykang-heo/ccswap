#!/usr/bin/env python3
"""Regenerate checked-in Python goldens for the TS parity tests.

Runs the real Python CLI against `tests-ts/fixtures/<name>/home` (as HOME)
with network blocked and keychain reads stubbed, and stores stdout per
command under `tests-ts/golden/<name>/`.

Usage: uv run python tests-ts/generate-goldens.py [fixture...]
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import pathlib
import socket
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "src"))

FIXTURES = REPO / "tests-ts" / "fixtures"
GOLDEN = REPO / "tests-ts" / "golden"

COMMANDS: list[tuple[str, list[str]]] = [
    ("list.json", ["list", "--json"]),
    ("list-claude.json", ["list", "--json", "--provider", "claude"]),
    ("list-codex.json", ["list", "--json", "--provider", "codex"]),
    ("status.json", ["status", "--json"]),
    ("claude-list.json", ["claude", "list", "--json"]),
    ("codex-list.json", ["codex", "list", "--json"]),
    ("agy-list.json", ["agy", "list", "--json"]),
    ("agy-status.json", ["agy", "status", "--json"]),
    ("muse-list.json", ["muse", "list", "--json"]),
    ("kiro-list.json", ["kiro", "list", "--json"]),
    ("vendors.json", ["vendors", "--json"]),
    ("vendors-capabilities.json", ["vendors", "capabilities", "--json"]),
    ("usage.json", ["usage", "--json"]),
    ("usage-muse.json", ["usage", "muse", "--json"]),
    ("config-list.json", ["config", "list", "--json"]),
    ("config-get.json", ["config", "get", "autoswitch.threshold", "--json"]),
    ("alias.txt", ["alias"]),
    ("map.txt", ["map"]),
]


def _block_network() -> None:
    real_socket = socket.socket

    class Blocked(real_socket):  # type: ignore[misc]
        def connect(self, *args, **kwargs):  # noqa: ANN002, ANN003, ANN202
            raise OSError("network blocked in golden generation")

    socket.socket = Blocked  # type: ignore[assignment]


def _stub_keychain() -> None:
    from claude_swap import macos_keychain as kc

    kc.get_password = lambda *a, **k: None
    kc.item_exists = lambda *a, **k: False
    kc.set_password = lambda *a, **k: None
    kc.delete_password = lambda *a, **k: None
    try:
        from claude_swap import oauth

        oauth.fetch_oauth_profile = lambda token: None
    except Exception:
        pass


def run_command(argv: list[str]) -> tuple[int, str]:
    from claude_swap import cli

    sys.argv = ["ccswap", *argv]
    buf = io.StringIO()
    code = 0
    with contextlib.redirect_stdout(buf):
        try:
            cli.main()
        except SystemExit as exc:
            code = exc.code if isinstance(exc.code, int) else 0
    return code, buf.getvalue()


def generate(fixture: str) -> None:
    home = FIXTURES / fixture / "home"
    assert home.is_dir(), f"missing fixture home: {home}"
    os.environ["HOME"] = str(home)
    os.environ["USERPROFILE"] = str(home)
    pathlib.Path.home = lambda: home  # type: ignore[assignment]
    for var in (
        "CLAUDE_CONFIG_DIR",
        "CLAUDE_SECURESTORAGE_CONFIG_DIR",
        "XDG_DATA_HOME",
        "XDG_CONFIG_HOME",
        "ANTIGRAVITY_GEMINI_DIR",
        "CCSWAP_BACKUP_ROOT",
    ):
        os.environ.pop(var, None)
    # Deterministic vendor probes: fixture bin first.
    os.environ["PATH"] = f"{FIXTURES / fixture / 'bin'}:{os.environ['PATH']}"
    _block_network()
    _stub_keychain()

    out_dir = GOLDEN / fixture
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = []
    for filename, argv in COMMANDS:
        try:
            code, out = run_command(argv)
        except Exception as exc:  # noqa: BLE001 - record the failure, keep going
            code, out = 99, f"<generator error: {exc!r}>"
        (out_dir / filename).write_text(out, encoding="utf-8")
        manifest.append({"file": filename, "argv": argv, "exit": code})
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    _dump_caches(home, out_dir)
    print(f"{fixture}: wrote {len(manifest)} goldens to {out_dir}")


def _dump_caches(home: pathlib.Path, out_dir: pathlib.Path) -> None:
    """Python's own stored-state readers, as the oracle for TS cache parity."""
    from claude_swap import paths
    from claude_swap.vendors.usage_cache import UsageCache

    root = paths.get_backup_root()
    assert str(root).startswith(str(home)), f"backup root escaped fixture: {root}"
    vendor_cache = UsageCache(root / "vendors")
    try:
        raw_entries = json.loads((root / "vendors" / "usage.json").read_text())
    except (OSError, ValueError):
        raw_entries = {}
    readable = {}
    for key in (raw_entries.get("entries") or {}):
        tool, _, account = key.partition("\x1f")
        try:
            result = vendor_cache.get(tool, account)
        except Exception:  # noqa: BLE001 - record unreadable, keep going
            result = None
        readable[key] = None if result is None else result.to_json()
    (out_dir / "vendor-cache.json").write_text(json.dumps(readable, indent=2) + "\n")
    try:
        claude_rows = json.loads((root / "cache" / "usage.json").read_text())
    except (OSError, ValueError):
        claude_rows = {}
    (out_dir / "claude-cache.json").write_text(json.dumps(claude_rows, indent=2) + "\n")


if __name__ == "__main__":
    names = sys.argv[1:] or sorted(p.name for p in FIXTURES.iterdir() if p.is_dir())
    for name in names:
        generate(name)

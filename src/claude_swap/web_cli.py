"""``ccswap web``: the usage dashboard, run in the foreground or kept always on.

``serve`` runs ``web_server`` in the foreground. ``install`` makes it durable
with two steps that are each reversible: a LaunchAgent (``launch_agent``) that
runs ``ccswap web serve`` at login and restarts it on crash, and one
``tailscale serve`` mapping from a tailnet HTTPS port to the loopback socket.

``tailscale serve`` keeps one mapping per port and every other mapping on the
machine belongs to the user. So before writing or removing the HTTPS mapping
this module reads ``tailscale serve status --json`` and touches the port only
when the mapping there is ours, or is absent. Anything else is refused, with
nothing changed.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

from claude_swap import launch_agent, web_server
from claude_swap.exceptions import ClaudeSwitchError

WEB_LABEL = launch_agent.WEB_LABEL
DEFAULT_PORT = web_server.DEFAULT_PORT
DEFAULT_HTTPS_PORT = 8443
APP_TAILSCALE = Path("/Applications/Tailscale.app/Contents/MacOS/Tailscale")
_TAILSCALE_TIMEOUT_S = 15


def tailscale_binary() -> str | None:
    """The Tailscale app's CLI when installed, else ``tailscale`` on PATH."""
    if APP_TAILSCALE.exists():
        return str(APP_TAILSCALE)
    return shutil.which("tailscale")


def local_url(port: int) -> str:
    return f"http://{web_server.HOST}:{port}/"


def _target(port: int) -> str:
    return f"http://{web_server.HOST}:{port}"


def _tailscale(ts: str, *args: str) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            [ts, *args],
            capture_output=True,
            text=True,
            check=False,
            timeout=_TAILSCALE_TIMEOUT_S,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise ClaudeSwitchError(f"tailscale could not run: {exc}") from exc


def _detail(result: subprocess.CompletedProcess) -> str:
    return (result.stderr or result.stdout or "").strip()


def _mapped_targets(ts: str, https_port: int) -> set[str] | None:
    """What the HTTPS port on this node already serves, as comparable strings.

    ``set()`` when nothing is mapped there. ``None`` when the mappings cannot
    be read; callers must then leave the port alone.
    """
    result = _tailscale(ts, "serve", "status", "--json")
    if result.returncode != 0:
        return None
    try:
        data = json.loads(result.stdout or "{}")
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    found: set[str] = set()
    web = data.get("Web") if isinstance(data.get("Web"), dict) else {}
    for host_port, site in web.items():
        if not isinstance(host_port, str) or host_port.rpartition(":")[2] != str(https_port):
            continue
        handlers = site.get("Handlers") if isinstance(site, dict) else None
        for handler in (handlers or {}).values():
            proxy = handler.get("Proxy") if isinstance(handler, dict) else None
            found.add(str(proxy).rstrip("/") if proxy else "unknown handler")
    tcp = data.get("TCP") if isinstance(data.get("TCP"), dict) else {}
    if str(https_port) in tcp:
        found.add("tcp listener")
    return found


def _tailnet_url(ts: str, https_port: int) -> str | None:
    try:
        result = _tailscale(ts, "status", "--json")
        data = json.loads(result.stdout or "{}") if result.returncode == 0 else {}
    except (ClaudeSwitchError, ValueError):
        return None
    self_node = data.get("Self") if isinstance(data, dict) else None
    dns_name = self_node.get("DNSName") if isinstance(self_node, dict) else None
    if not isinstance(dns_name, str) or not dns_name.strip("."):
        return None
    return f"https://{dns_name.rstrip('.')}:{https_port}/"


def _agent_program(port: int) -> list[str]:
    return [*launch_agent.resolve_program(), "web", "serve", "--port", str(port)]


def _local_answering(port: int) -> bool:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(f"{local_url(port)}api/usage", timeout=2) as response:
            return response.status == 200
    except (OSError, ValueError):
        return False


def install(port: int, https_port: int) -> int:
    ts = tailscale_binary()
    ours = _target(port)
    if ts is not None:
        mapped = _mapped_targets(ts, https_port)
        if mapped is None:
            raise ClaudeSwitchError(
                "could not read `tailscale serve status`; nothing was changed"
            )
        foreign = mapped - {ours}
        if foreign:
            raise ClaudeSwitchError(
                f"HTTPS port {https_port} already serves {', '.join(sorted(foreign))}; "
                "pick another with --https-port. Nothing was changed."
            )

    agent = launch_agent.install(
        label=WEB_LABEL, program=_agent_program(port)
    )
    print(f"Installed LaunchAgent {WEB_LABEL} ({agent['plist']}).")

    if ts is None:
        print(f"Local URL: {local_url(port)}")
        print(
            "Tailscale was not found, so the page is only reachable on this Mac. Install "
            "Tailscale, then run `ccswap web install` again for the tailnet URL."
        )
        return 0

    served = _tailscale(ts, "serve", "--bg", f"--https={https_port}", ours)
    if served.returncode != 0:
        print(
            f"The dashboard runs at {local_url(port)} but tailscale serve failed: "
            f"{_detail(served) or 'exit ' + str(served.returncode)}\n"
            "Fix Tailscale and run `ccswap web install` again.",
            file=sys.stderr,
        )
        return 1

    url = _tailnet_url(ts, https_port)
    print(f"Tailnet URL: {url or '(could not read the node name from tailscale status)'}")
    print(f"Local URL:   {local_url(port)}")
    return 0


def uninstall(port: int, https_port: int) -> int:
    launch_agent.uninstall(label=WEB_LABEL)
    print(f"Removed LaunchAgent {WEB_LABEL}.")

    ts = tailscale_binary()
    if ts is None:
        print("Tailscale was not found; no tailscale serve mapping to remove.")
        return 0
    mapped = _mapped_targets(ts, https_port)
    if mapped is None:
        print(f"Could not read tailscale serve status; HTTPS port {https_port} left as is.")
        return 0
    if not mapped:
        print(f"No tailscale serve mapping on HTTPS port {https_port}.")
        return 0
    if mapped != {_target(port)}:
        print(f"HTTPS port {https_port} serves something other than the dashboard; left as is.")
        return 0
    removed = _tailscale(ts, "serve", f"--https={https_port}", "off")
    if removed.returncode != 0:
        print(f"tailscale serve off failed: {_detail(removed)}", file=sys.stderr)
        return 1
    print(f"Removed tailscale serve mapping on HTTPS port {https_port}.")
    return 0


def _macos() -> bool:
    return sys.platform == "darwin"


def status(port: int, https_port: int, as_json: bool) -> int:
    agent: dict | None = None
    if _macos():
        try:
            agent = launch_agent.status(label=WEB_LABEL)
        except ClaudeSwitchError:
            agent = None
    answering = _local_answering(port)

    tailnet: str | None = None
    ts = tailscale_binary()
    if ts is not None:
        try:
            mapped = _mapped_targets(ts, https_port)
        except ClaudeSwitchError:
            mapped = None  # status reports what it can; it does not fail on tailscale
        if mapped == {_target(port)}:
            tailnet = _tailnet_url(ts, https_port)

    report = {
        "agent": {
            "label": WEB_LABEL,
            "installed": bool(agent and agent["installed"]),
            "loaded": bool(agent and agent["loaded"]),
            "pid": agent["pid"] if agent else None,
        },
        "localUrl": local_url(port),
        "localAnswering": answering,
        "tailnetUrl": tailnet,
    }
    if as_json:
        print(json.dumps(report, indent=2))
        return 0

    loaded = "loaded" if report["agent"]["loaded"] else "not loaded"
    print(f"LaunchAgent {WEB_LABEL}: {loaded}")
    print(f"Local URL:   {report['localUrl']} ({'answering' if answering else 'not answering'})")
    print(f"Tailnet URL: {tailnet or 'none (not served on this node)'}")
    return 0


def web_command(argv: list[str]) -> int:
    """Entry point for ``ccswap web ...``. Returns the process exit code."""
    parser = argparse.ArgumentParser(
        prog="ccswap web",
        description=(
            "Usage dashboard for Claude accounts. `serve` runs it in the foreground; "
            "`install` keeps it running and serves it on your tailnet."
        ),
    )
    commands = parser.add_subparsers(dest="action", required=True)

    def add_ports(cmd: argparse.ArgumentParser, *, https: bool) -> None:
        cmd.add_argument("--port", type=_port, default=DEFAULT_PORT,
                         help=f"local port (default {DEFAULT_PORT})")
        if https:
            cmd.add_argument("--https-port", type=_port, default=DEFAULT_HTTPS_PORT,
                             help=f"tailnet HTTPS port (default {DEFAULT_HTTPS_PORT})")

    add_ports(commands.add_parser("serve", help="run the dashboard in the foreground"),
              https=False)
    add_ports(commands.add_parser("install", help="always-on LaunchAgent + tailnet HTTPS"),
              https=True)
    add_ports(commands.add_parser("uninstall", help="remove the LaunchAgent and tailnet mapping"),
              https=True)
    status_cmd = commands.add_parser("status", help="show whether the dashboard is running")
    add_ports(status_cmd, https=True)
    status_cmd.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    try:
        if args.action == "serve":
            try:
                return web_server.serve(args.port)
            except OSError as exc:
                print(f"Cannot serve on {web_server.HOST}:{args.port}: {exc}", file=sys.stderr)
                return 1
        if args.action == "install":
            return install(args.port, args.https_port)
        if args.action == "uninstall":
            return uninstall(args.port, args.https_port)
        return status(args.port, args.https_port, args.json)
    except ClaudeSwitchError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


def _port(text: str) -> int:
    try:
        value = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a port number: {text!r}") from None
    if not 1 <= value <= 65535:
        raise argparse.ArgumentTypeError(f"port out of range: {value}")
    return value

from __future__ import annotations

from pathlib import Path
import json
import plistlib
import subprocess
import threading
import urllib.error
import urllib.request
from importlib import resources
from types import SimpleNamespace

import pytest

from claude_swap import launch_agent, web_cli, web_server

PAYLOAD = {
    "schemaVersion": 1,
    "activeAccountNumber": 1,
    "accounts": [{"number": 1, "email": "a@example.com", "active": True, "usageStatus": "ok"}],
}


def _opener():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _get(port: int, path: str):
    """``(status, headers, body)``; HTTP error statuses are returned, not raised."""
    try:
        with _opener().open(f"http://127.0.0.1:{port}{path}", timeout=5) as response:
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.headers, exc.read()


@pytest.fixture
def running(request):
    """A server on an ephemeral port, serving a snapshot already refreshed once."""
    calls = []

    def provider():
        calls.append(1)
        return PAYLOAD

    snapshot = web_server.Snapshot(provider)
    assert snapshot.refresh() is True
    server = web_server.make_server(0, snapshot)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    request.addfinalizer(lambda: (server.shutdown(), server.server_close()))
    return SimpleNamespace(port=server.server_address[1], calls=calls, snapshot=snapshot)


def test_api_usage_returns_the_payload_with_no_store(running):
    status, headers, body = _get(running.port, "/api/usage")

    assert status == 200
    assert headers["Cache-Control"] == "no-store"
    assert headers["Content-Type"].startswith("application/json")
    document = json.loads(body)
    assert document["claude"]["accounts"] == [{**PAYLOAD["accounts"][0], "rank": 1}]
    assert document["generatedAt"].endswith("Z")


def test_requests_never_trigger_a_collection(running):
    before = len(running.calls)

    for _ in range(3):
        _get(running.port, "/api/usage")
        _get(running.port, "/")

    assert len(running.calls) == before


def test_root_serves_one_self_contained_page_that_polls_api_usage(running):
    status, headers, body = _get(running.port, "/")

    assert status == 200
    assert headers["Content-Type"].startswith("text/html")
    assert headers["Cache-Control"] == "no-store"
    html = body.decode()
    assert 'fetch("/api/usage"' in html
    assert 'name="color-scheme" content="dark"' in html
    assert "<style>" in html and "<script>" in html
    # Self-contained: nothing loaded from another origin.
    assert "http://" not in html and "https://" not in html
    assert "<link" not in html and "src=" not in html


def test_unknown_paths_are_404(running):
    for path in ("/index.html", "/api", "/api/usage/extra", "/nope"):
        status, _headers, _body = _get(running.port, path)
        assert status == 404, path


def test_api_usage_before_the_first_collection_reports_no_reading():
    snapshot = web_server.Snapshot(lambda: PAYLOAD)
    server = web_server.make_server(0, snapshot)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        _status, _headers, body = _get(server.server_address[1], "/api/usage")
    finally:
        server.shutdown()
        server.server_close()

    assert json.loads(body) == {
        "generatedAt": None, "claude": None, "tools": [], "toolsGeneratedAt": None
    }


def test_a_failing_collection_keeps_the_last_good_snapshot():
    outcomes = iter([PAYLOAD, RuntimeError("keychain locked")])

    def provider():
        outcome = next(outcomes)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    snapshot = web_server.Snapshot(provider, clock=lambda: 1_794_536_517.0)
    assert snapshot.refresh() is True
    assert snapshot.refresh() is False

    assert snapshot.document()["claude"]["accounts"] == [{**PAYLOAD["accounts"][0], "rank": 1}]


def test_poller_collects_on_its_own_interval():
    seen = threading.Event()
    count = []

    def provider():
        count.append(1)
        if len(count) >= 2:
            seen.set()
        return PAYLOAD

    snapshot = web_server.Snapshot(provider)
    poller = web_server.Poller(snapshot, interval=0.01)
    poller.start()
    try:
        assert seen.wait(5)
    finally:
        poller.stop()
        poller.join(5)


def test_the_page_ships_as_package_data():
    html = resources.files("claude_swap").joinpath("web_assets/index.html").read_bytes()
    assert b"<!doctype html>" in html.lower()


def test_api_usage_includes_stubbed_non_claude_tools(monkeypatch):
    from claude_swap.vendors.overview import Overview, ToolSummary

    overview = Overview(legacy=[], service=SimpleNamespace(registry={}))
    overview.tools = lambda: ["codex", "muse", "kiro"]
    overview.collect_one = lambda tool, *, refresh=False: ToolSummary(tool, tool.title())
    monkeypatch.setattr(web_server, "_web_overview", lambda: overview)
    snapshot = web_server.Snapshot(lambda: PAYLOAD)
    snapshot.set_tools(web_server._overview_tools(), 1_794_536_517.0)
    server = web_server.make_server(0, snapshot)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        _status, _headers, body = _get(server.server_address[1], "/api/usage")
    finally:
        server.shutdown()
        server.server_close()
    document = json.loads(body)
    assert [tool["tool"] for tool in document["tools"]] == ["codex", "muse", "kiro"]
    assert document["toolsGeneratedAt"].endswith("Z")


def test_a_tool_collection_error_does_not_drop_other_overview_tools(monkeypatch):
    from claude_swap.vendors.overview import Overview, ToolSummary

    overview = Overview(legacy=[], service=SimpleNamespace(registry={}))
    overview.tools = lambda: ["codex", "muse", "kiro"]

    def collect_one(tool, *, refresh=False):
        if tool == "muse":
            raise RuntimeError("probe failed")
        return ToolSummary(tool, tool.title())

    overview.collect_one = collect_one
    monkeypatch.setattr(web_server, "_web_overview", lambda: overview)
    tools = web_server._overview_tools()
    assert [tool["tool"] for tool in tools] == ["codex", "muse", "kiro"]
    assert tools[1]["error"] == "RuntimeError while reading this tool"


def test_page_references_non_claude_tools_and_compact_rows(running):
    _status, _headers, body = _get(running.port, "/")
    html = body.decode()
    assert "snapshot.tools" in html
    assert "resetCredits" in html
    assert 'el("span","rank"' in html


def test_api_usage_orders_claude_accounts_by_headroom():
    claude = {"accounts": [
        {"number": 2, "usageStatus": "ok", "usage": {"fiveHour": {"pct": 80}, "sevenDay": {"pct": 30}}},
        {"number": 1, "usageStatus": "ok", "usage": {"fiveHour": {"pct": 10}, "sevenDay": {"pct": 20}}},
    ]}
    snapshot = web_server.Snapshot(lambda: claude)
    assert snapshot.refresh()
    server = web_server.make_server(0, snapshot)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        _status, _headers, body = _get(server.server_address[1], "/api/usage")
    finally:
        server.shutdown()
        server.server_close()
    accounts = json.loads(body)["claude"]["accounts"]
    assert [(a["number"], a["rank"]) for a in accounts] == [(1, 1), (2, 2)]


# -- ccswap web install / uninstall / status ---------------------------------

SERVE_CONFIG_EMPTY: dict = {}
OUR_MAPPING = {
    "Web": {
        "mac.tail1234.ts.net:8443": {
            "Handlers": {"/": {"Proxy": "http://127.0.0.1:4592"}}
        }
    }
}
FOREIGN_MAPPING = {
    "Web": {
        "mac.tail1234.ts.net:8443": {
            "Handlers": {"/": {"Proxy": "http://127.0.0.1:9999"}}
        }
    }
}


@pytest.fixture
def tailscale(monkeypatch, tmp_path):
    """A present Tailscale binary whose every invocation is recorded and answered."""
    binary = tmp_path / "Tailscale"
    binary.write_text("")
    monkeypatch.setattr(web_cli, "APP_TAILSCALE", binary)
    state = {
        "serve": dict(SERVE_CONFIG_EMPTY),
        "serve_rc": 0,
        "status": {"Self": {"DNSName": "mac.tail1234.ts.net."}},
    }
    calls: list[list[str]] = []

    def run(argv, **_kwargs):
        argv = list(argv)
        calls.append(argv)
        if argv[1:] == ["serve", "status", "--json"]:
            return subprocess.CompletedProcess(argv, 0, json.dumps(state["serve"]), "")
        if argv[1:] == ["status", "--json"]:
            return subprocess.CompletedProcess(argv, 0, json.dumps(state["status"]), "")
        if argv[1] == "serve" and "--bg" in argv:
            return subprocess.CompletedProcess(argv, state["serve_rc"], "", "tailnet has no HTTPS")
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(web_cli.subprocess, "run", run)
    return SimpleNamespace(calls=calls, state=state, binary=str(binary))


@pytest.fixture
def agent(monkeypatch):
    """launch_agent is replaced wholesale: no plist written, no launchctl run."""
    installs, uninstalls = [], []
    monkeypatch.setattr(launch_agent, "resolve_program", lambda: ["/usr/local/bin/ccswap"])
    monkeypatch.setattr(
        launch_agent,
        "install",
        lambda **kw: installs.append(kw) or {
            "label": kw["label"], "plist": "/home/u/Library/LaunchAgents/x.plist",
        },
    )
    monkeypatch.setattr(
        launch_agent,
        "uninstall",
        lambda **kw: uninstalls.append(kw) or {"label": kw["label"], "removed_plist": True},
    )
    return SimpleNamespace(installs=installs, uninstalls=uninstalls)


def test_install_registers_the_web_label_with_serve_args_and_keepalive_program(
    agent, tailscale, tmp_path, capsys
):
    rc = web_cli.web_command(["install", "--port", "4592", "--https-port", "8443"])

    assert rc == 0
    assert agent.installs == [
        {
            "label": "io.github.ccswap.web",
            "program": ["/usr/local/bin/ccswap", "web", "serve", "--port", "4592"],
        }
    ]
    # The plist carries exactly that argv (no extra subcommand) and keeps the job alive.
    plist = plistlib.loads(
        launch_agent.build_plist(
            agent.installs[0]["program"], label=launch_agent.WEB_LABEL, home=tmp_path
        )
    )
    assert plist["Label"] == "io.github.ccswap.web"
    assert plist["ProgramArguments"] == ["/usr/local/bin/ccswap", "web", "serve", "--port", "4592"]
    assert plist["KeepAlive"] == {"SuccessfulExit": False}
    assert [tailscale.binary, "serve", "--bg", "--https=8443", "http://127.0.0.1:4592"] in tailscale.calls
    out = capsys.readouterr().out
    assert "https://mac.tail1234.ts.net:8443/" in out
    assert "http://127.0.0.1:4592/" in out


def test_install_without_tailscale_still_installs_the_agent_and_says_so(
    monkeypatch, agent, tmp_path, capsys
):
    monkeypatch.setattr(web_cli, "APP_TAILSCALE", tmp_path / "missing")
    monkeypatch.setattr(web_cli.shutil, "which", lambda name: None)
    ran = []
    monkeypatch.setattr(web_cli.subprocess, "run", lambda argv, **kw: ran.append(argv))

    rc = web_cli.web_command(["install"])

    assert rc == 0
    assert len(agent.installs) == 1
    assert ran == []
    out = capsys.readouterr().out
    assert "http://127.0.0.1:4592/" in out
    assert "Tailscale was not found" in out


def test_install_refuses_an_https_port_that_serves_something_else(agent, tailscale, capsys):
    tailscale.state["serve"] = FOREIGN_MAPPING

    rc = web_cli.web_command(["install"])

    assert rc == 1
    assert agent.installs == []
    assert not any("--bg" in call for call in tailscale.calls)
    assert "already serves" in capsys.readouterr().err


def test_install_reports_a_failed_serve_without_touching_other_mappings(agent, tailscale, capsys):
    tailscale.state["serve_rc"] = 1

    rc = web_cli.web_command(["install"])

    assert rc == 1
    assert len(agent.installs) == 1  # the agent is kept; the message says how to retry
    assert "tailscale serve failed" in capsys.readouterr().err
    assert not any("off" in call for call in tailscale.calls)


def test_uninstall_removes_only_our_mapping(agent, tailscale):
    tailscale.state["serve"] = OUR_MAPPING

    rc = web_cli.web_command(["uninstall", "--https-port", "8443"])

    assert rc == 0
    assert agent.uninstalls == [{"label": "io.github.ccswap.web"}]
    assert [tailscale.binary, "serve", "--https=8443", "off"] in tailscale.calls


def test_uninstall_leaves_a_foreign_mapping_on_the_same_port_alone(agent, tailscale):
    tailscale.state["serve"] = FOREIGN_MAPPING

    rc = web_cli.web_command(["uninstall", "--https-port", "8443"])

    assert rc == 0
    assert agent.uninstalls
    assert not any("off" in call for call in tailscale.calls)


def test_status_json_reports_agent_local_and_tailnet_urls(agent, tailscale, monkeypatch, capsys):
    tailscale.state["serve"] = OUR_MAPPING
    monkeypatch.setattr(
        launch_agent,
        "status",
        lambda **kw: {"installed": True, "loaded": True, "pid": 42, "state": "running"},
    )
    monkeypatch.setattr(web_cli, "_local_answering", lambda port: True)
    monkeypatch.setattr(web_cli, "_macos", lambda: True)

    rc = web_cli.web_command(["status", "--json"])

    assert rc == 0
    report = json.loads(capsys.readouterr().out)
    assert report["agent"] == {
        "label": "io.github.ccswap.web", "installed": True, "loaded": True, "pid": 42,
    }
    assert report["localAnswering"] is True
    assert report["localUrl"] == "http://127.0.0.1:4592/"
    assert report["tailnetUrl"] == "https://mac.tail1234.ts.net:8443/"


# The exact `tailscale serve status --json` a Mac prints once `install` has
# mapped HTTPS 8443 to the dashboard: the TCP listener sits beside the Web
# handler, and it is ours, not a foreign owner of the port.
REAL_SERVE_STATUS_WITH_LISTENER = {
    "TCP": {"443": {"HTTPS": True}, "8443": {"HTTPS": True}},
    "Web": {
        "work-mac.tail01328d.ts.net:443": {
            "Handlers": {"/": {"Proxy": "http://127.0.0.1:4591"}}
        },
        "work-mac.tail01328d.ts.net:8443": {
            "Handlers": {"/": {"Proxy": "http://127.0.0.1:4592"}}
        },
    },
}


def test_status_reports_the_tailnet_url_of_a_mapping_with_its_tcp_listener(
    agent, tailscale, monkeypatch, capsys
):
    tailscale.state["serve"] = REAL_SERVE_STATUS_WITH_LISTENER
    tailscale.state["status"] = {"Self": {"DNSName": "work-mac.tail01328d.ts.net."}}
    monkeypatch.setattr(web_cli, "_local_answering", lambda port: True)
    monkeypatch.setattr(web_cli, "_macos", lambda: True)
    monkeypatch.setattr(launch_agent, "status", lambda **kw: {
        "installed": True, "loaded": True, "pid": 42,
    })

    assert web_cli.web_command(["status"]) == 0

    assert "Tailnet URL: https://work-mac.tail01328d.ts.net:8443/" in capsys.readouterr().out


def test_install_again_over_its_own_mapping_is_not_refused(agent, tailscale, capsys):
    tailscale.state["serve"] = REAL_SERVE_STATUS_WITH_LISTENER
    tailscale.state["status"] = {"Self": {"DNSName": "work-mac.tail01328d.ts.net."}}

    rc = web_cli.web_command(["install", "--https-port", "8443"])

    assert rc == 0
    assert len(agent.installs) == 1
    assert "already serves" not in capsys.readouterr().err


def test_a_tcp_forward_on_the_https_port_is_still_someone_elses(agent, tailscale, capsys):
    tailscale.state["serve"] = {
        "TCP": {"8443": {"TCPForward": "127.0.0.1:5432"}},
    }

    rc = web_cli.web_command(["install", "--https-port", "8443"])

    assert rc == 1
    assert agent.installs == []
    assert "already serves" in capsys.readouterr().err


def test_status_has_no_tailnet_url_when_the_mapping_is_not_ours(agent, tailscale, monkeypatch, capsys):
    tailscale.state["serve"] = dict(SERVE_CONFIG_EMPTY)
    monkeypatch.setattr(web_cli, "_local_answering", lambda port: False)
    monkeypatch.setattr(web_cli, "_macos", lambda: True)
    monkeypatch.setattr(launch_agent, "status", lambda **kw: {
        "installed": False, "loaded": False, "pid": None,
    })

    assert web_cli.web_command(["status"]) == 0

    out = capsys.readouterr().out
    assert "Tailnet URL: none" in out
    assert "not answering" in out


def test_dashboard_overview_fetches_legacy_tools():
    web_server._web_overview.cache_clear()
    try:
        assert web_server._web_overview().legacy_fetch is True
    finally:
        web_server._web_overview.cache_clear()


def test_tool_sections_cannot_collapse():
    html = (Path(web_server.__file__).parent / "web_assets" / "index.html").read_text()
    assert "<details" not in html and '"details"' not in html

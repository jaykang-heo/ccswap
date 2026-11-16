"""A service notices that a repin replaced the install it runs from."""

from __future__ import annotations

from claude_swap import service_freshness as sf


def test_install_dir_reads_the_mise_install_folder():
    path = "/Users/x/.local/share/mise/installs/pipx-ccswap-abc123/latest/ccswap/lib/x.py"
    assert sf.install_dir(path) == "pipx-ccswap-abc123"
    assert sf.install_dir("/usr/lib/python3/claude_swap/x.py") is None


def test_superseded_only_when_both_installs_are_known_and_differ(monkeypatch):
    monkeypatch.setattr(sf, "running_install", lambda: "pipx-ccswap-old")
    monkeypatch.setattr(sf, "current_install", lambda timeout=10.0: "pipx-ccswap-new")
    assert sf.superseded() is True
    monkeypatch.setattr(sf, "current_install", lambda timeout=10.0: "pipx-ccswap-old")
    assert sf.superseded() is False
    monkeypatch.setattr(sf, "current_install", lambda timeout=10.0: None)
    assert sf.superseded() is False


def test_check_is_rate_limited_and_exits_when_superseded(monkeypatch):
    calls = []
    monkeypatch.setattr(sf, "exit_if_superseded", lambda label: calls.append(label))
    now = [0.0]
    check = sf.FreshnessCheck("com.ccswap.menubar", every=300, clock=lambda: now[0])
    check.tick()
    now[0] = 299
    check.tick()
    assert calls == []
    now[0] = 301
    check.tick()
    assert calls == ["com.ccswap.menubar"]


def test_exit_if_superseded_exits_non_zero_for_launchd(monkeypatch):
    exits = []
    monkeypatch.setattr(sf, "superseded", lambda: True)
    monkeypatch.setattr(sf, "running_install", lambda: "old")
    monkeypatch.setattr(sf, "current_install", lambda timeout=10.0: "new")
    monkeypatch.setattr(sf, "_reinstall_detached", lambda label: None)
    monkeypatch.setattr(sf.os, "_exit", lambda code: exits.append(code))
    sf.exit_if_superseded("io.github.ccswap.web")
    assert exits == [sf.SUPERSEDED_EXIT] and sf.SUPERSEDED_EXIT != 0

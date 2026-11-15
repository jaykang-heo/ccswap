from __future__ import annotations

import io
import json
import stat
import sys
from unittest.mock import MagicMock, patch

import pytest

from claude_swap import cli, web_usage
from claude_swap.usage_store import UsageEntry

NOW = 1_794_536_517.0
SECRET = "sk-ant-sid01-SECRET-VALUE-XYZ"
WEB_USAGE = {
    "five_hour": {"pct": 42.0, "resets_at": "2026-11-15T10:00:00+00:00"},
    "seven_day": {"pct": 7.0, "resets_at": "2026-11-19T16:59:59+00:00"},
}
OAUTH_LAST_GOOD = {
    "five_hour": {"pct": 10.0, "resets_at": "2026-11-15T09:00:00+00:00"},
    "seven_day": {"pct": 5.0, "resets_at": "2026-11-19T16:59:59+00:00"},
    "reset_credits": {"available": 2},
}


def stored(fetched_at, last_good=None, sentinel=None):
    return UsageEntry(
        sentinel=sentinel,
        last_good=OAUTH_LAST_GOOD if last_good is None else last_good,
        fetched_at=fetched_at,
        age_s=NOW - fetched_at,
    )


# -- overlay -----------------------------------------------------------------


def test_overlay_applies_a_newer_web_reading_and_marks_its_source():
    entries = {"3": stored(NOW - 300)}
    readings = {"3": (NOW - 5, WEB_USAGE)}

    out = web_usage.overlay(entries, readings, NOW)

    assert out["3"].fetched_at == NOW - 5
    assert out["3"].age_s == 5
    assert out["3"].last_good["five_hour"]["pct"] == 42.0
    assert out["3"].last_good["source"] == "web"


def test_overlay_ignores_a_reading_not_newer_than_the_stored_measurement():
    entries = {"3": stored(NOW - 10)}
    readings = {"3": (NOW - 60, WEB_USAGE)}

    out = web_usage.overlay(entries, readings, NOW)

    assert out == entries


def test_overlay_leaves_sentinel_entries_alone():
    entries = {"3": stored(NOW - 300, sentinel="relogin-required")}
    readings = {"3": (NOW - 5, WEB_USAGE)}

    out = web_usage.overlay(entries, readings, NOW)

    assert out["3"] is entries["3"]


def test_overlay_keeps_stored_keys_the_web_result_lacks():
    entries = {"3": stored(NOW - 300)}
    readings = {"3": (NOW - 5, WEB_USAGE)}

    out = web_usage.overlay(entries, readings, NOW)

    assert out["3"].last_good["reset_credits"] == {"available": 2}
    assert out["3"].last_good["seven_day"]["pct"] == 7.0


def test_overlay_ignores_readings_for_unknown_accounts():
    entries = {"3": stored(NOW - 300)}
    readings = {"9": (NOW - 5, WEB_USAGE)}

    assert web_usage.overlay(entries, readings, NOW) == entries


# -- fetch -------------------------------------------------------------------


class FakeResponse:
    def __init__(self, status_code, body=None, headers=None):
        self.status_code = status_code
        self._body = body
        self.headers = headers or {}

    def json(self):
        if self._body is None:
            raise ValueError("no JSON body")
        return self._body


class FakeRequests:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.calls = []

    def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        if self.error is not None:
            raise self.error
        return self.response


@pytest.mark.parametrize(
    ("status", "expected_kind"),
    [(401, "web-key-invalid"), (403, "web-key-invalid"), (500, "http-500")],
)
def test_fetch_maps_rejections_and_server_errors(monkeypatch, status, expected_kind):
    fake = FakeRequests(FakeResponse(status))
    monkeypatch.setattr(web_usage, "_requests", lambda: fake)

    usage, kind, retry = web_usage.fetch("org-1", SECRET)

    assert (usage, kind, retry) == (None, expected_kind, None)


def test_fetch_success_returns_normalized_usage_and_sends_the_cookie(monkeypatch):
    body = {
        "five_hour": {"utilization": 42.0, "resets_at": "2026-11-15T10:00:00+00:00"},
        "seven_day": {"utilization": 7.0, "resets_at": "2026-11-19T16:59:59+00:00"},
    }
    fake = FakeRequests(FakeResponse(200, body))
    monkeypatch.setattr(web_usage, "_requests", lambda: fake)

    usage, kind, retry = web_usage.fetch("org-1", SECRET)

    assert kind is None and retry is None
    assert usage["five_hour"]["pct"] == 42.0
    assert usage["seven_day"]["pct"] == 7.0
    url, kwargs = fake.calls[0]
    assert url == "https://claude.ai/api/organizations/org-1/usage"
    assert kwargs["cookies"] == {"sessionKey": SECRET}
    assert kwargs["impersonate"] == "chrome"


def test_fetch_429_carries_retry_after(monkeypatch):
    fake = FakeRequests(FakeResponse(429, headers={"Retry-After": "120"}))
    monkeypatch.setattr(web_usage, "_requests", lambda: fake)

    assert web_usage.fetch("org-1", SECRET) == (None, "http-429", 120.0)


def test_fetch_network_failure_is_reported_without_raising(monkeypatch):
    fake = FakeRequests(error=ConnectionError("reset"))
    monkeypatch.setattr(web_usage, "_requests", lambda: fake)

    assert web_usage.fetch("org-1", SECRET) == (None, "network", None)


def test_fetch_is_disabled_when_curl_cffi_is_missing(monkeypatch):
    monkeypatch.setitem(sys.modules, "curl_cffi", None)

    assert web_usage.fetch("org-1", SECRET) == (None, "web-unavailable", None)


# -- refresh -----------------------------------------------------------------


@pytest.fixture
def file_keys(monkeypatch):
    monkeypatch.setattr(web_usage, "_keychain_enabled", lambda: False)


@pytest.fixture
def fetch_spy(monkeypatch):
    calls = []

    def fake_fetch(org_uuid, key):
        calls.append((org_uuid, key))
        return WEB_USAGE, None, None

    monkeypatch.setattr(web_usage, "fetch", fake_fetch)
    return calls


def test_refresh_skips_accounts_without_a_key(tmp_path, file_keys, fetch_spy):
    web_usage.set_key(tmp_path, "a@example.com", SECRET)
    accounts = [("1", "a@example.com", "org-a"), ("2", "b@example.com", "org-b")]

    web_usage.refresh(tmp_path, accounts, NOW)

    assert fetch_spy == [("org-a", SECRET)]
    assert web_usage.load(tmp_path, NOW).keys() == {"1"}


def test_refresh_respects_the_ttl(tmp_path, file_keys, fetch_spy):
    web_usage.set_key(tmp_path, "a@example.com", SECRET)
    accounts = [("1", "a@example.com", "org-a")]
    web_usage.refresh(tmp_path, accounts, NOW)
    fetch_spy.clear()

    web_usage.refresh(tmp_path, accounts, NOW + web_usage.TTL_S - 1)
    assert fetch_spy == []

    web_usage.refresh(tmp_path, accounts, NOW + web_usage.TTL_S + 1)
    assert fetch_spy == [("org-a", SECRET)]


def test_refresh_does_not_fetch_inside_a_429_retry_window(
    tmp_path, file_keys, monkeypatch
):
    web_usage.set_key(tmp_path, "a@example.com", SECRET)
    accounts = [("1", "a@example.com", "org-a")]
    monkeypatch.setattr(web_usage, "fetch", lambda org, key: (None, "http-429", 5.0))
    web_usage.refresh(tmp_path, accounts, NOW)
    cached = json.loads((tmp_path / "cache" / "web_usage" / "1.json").read_text())
    assert cached["error"] == "http-429"
    assert cached["retryAt"] == NOW + 60  # Retry-After 5 s floors to 60 s

    fetched = []
    monkeypatch.setattr(
        web_usage, "fetch", lambda org, key: fetched.append(org) or (WEB_USAGE, None, None)
    )
    web_usage.refresh(tmp_path, accounts, NOW + 30)
    assert fetched == []

    web_usage.refresh(tmp_path, accounts, NOW + 61)
    assert fetched == ["org-a"]


def test_refresh_never_reads_the_keychain_for_accounts_without_a_key(
    tmp_path, monkeypatch, fetch_spy
):
    monkeypatch.setattr(web_usage, "_keychain_enabled", lambda: True)
    probes: list[str] = []
    monkeypatch.setattr(
        web_usage.macos_keychain, "get_password", lambda service, account: probes.append(account)
    )

    web_usage.refresh(tmp_path, [("1", "a@example.com", "org-a")], NOW)

    assert probes == [] and fetch_spy == []


def test_refresh_stores_the_reading_that_load_returns(tmp_path, file_keys, fetch_spy):
    web_usage.set_key(tmp_path, "a@example.com", SECRET)

    web_usage.refresh(tmp_path, [("1", "a@example.com", "org-a")], NOW)

    assert web_usage.load(tmp_path, NOW + 10) == {"1": (NOW, WEB_USAGE)}


# -- key store and status ----------------------------------------------------


def test_file_key_store_is_private_and_round_trips(tmp_path, file_keys):
    web_usage.set_key(tmp_path, "a@example.com", SECRET)

    key_file = tmp_path / "web_keys.json"
    assert stat.S_IMODE(key_file.stat().st_mode) == 0o600
    assert web_usage.get_key(tmp_path, "a@example.com") == SECRET
    assert web_usage.has_key(tmp_path, "a@example.com") is True

    web_usage.remove_key(tmp_path, "a@example.com")

    assert web_usage.get_key(tmp_path, "a@example.com") is None
    assert web_usage.has_key(tmp_path, "a@example.com") is False


def test_status_reports_keys_without_their_values(tmp_path, file_keys, fetch_spy):
    web_usage.set_key(tmp_path, "a@example.com", SECRET)
    accounts = [("1", "a@example.com", "org-a"), ("2", "b@example.com", "org-b")]
    web_usage.refresh(tmp_path, accounts, NOW)

    rows = web_usage.status(tmp_path, accounts, NOW + 4)

    assert rows == [
        {"num": "1", "email": "a@example.com", "hasKey": True,
         "observedAt": NOW, "ageS": 4.0, "error": None},
        {"num": "2", "email": "b@example.com", "hasKey": False,
         "observedAt": None, "ageS": None, "error": None},
    ]


# -- web-key CLI -------------------------------------------------------------


def _switcher(backup_dir):
    switcher = MagicMock()
    switcher.backup_dir = backup_dir
    switcher.roster_identities.return_value = [("3", "a@example.com", "org-a")]
    switcher.resolve_account.return_value = ("3", "a@example.com", "org-a")
    return switcher


def _run_web_key(monkeypatch, argv):
    monkeypatch.setattr(sys, "argv", ["ccswap", "web-key", *argv])
    with patch("claude_swap.update_check.check_for_update", return_value=None):
        cli.main()


def test_web_key_list_json_never_contains_a_key_value(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(web_usage, "_keychain_enabled", lambda: False)
    web_usage.set_key(tmp_path, "a@example.com", SECRET)
    switcher = _switcher(tmp_path)

    with patch("claude_swap.cli.ClaudeAccountSwitcher", return_value=switcher):
        _run_web_key(monkeypatch, ["list", "--json"])

    out = capsys.readouterr().out
    assert SECRET not in out
    rows = json.loads(out)
    assert rows[0]["num"] == "3" and rows[0]["hasKey"] is True


def test_web_key_set_refuses_a_key_for_another_account(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(web_usage, "_keychain_enabled", lambda: False)
    monkeypatch.setattr(web_usage, "validate_key", lambda key: "someone-else@example.com")
    switcher = _switcher(tmp_path)
    monkeypatch.setattr(sys, "stdin", io.StringIO(SECRET + "\n"))

    with patch("claude_swap.cli.ClaudeAccountSwitcher", return_value=switcher):
        with pytest.raises(SystemExit) as excinfo:
            _run_web_key(monkeypatch, ["set", "3", "--stdin"])

    captured = capsys.readouterr()
    assert excinfo.value.code == 1
    assert "nothing was saved" in captured.err
    assert SECRET not in captured.out + captured.err
    assert web_usage.has_key(tmp_path, "a@example.com") is False


def test_web_key_set_saves_a_key_that_matches_the_account(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(web_usage, "_keychain_enabled", lambda: False)
    monkeypatch.setattr(web_usage, "validate_key", lambda key: "A@example.com")
    switcher = _switcher(tmp_path)
    monkeypatch.setattr(sys, "stdin", io.StringIO(SECRET + "\n"))

    with patch("claude_swap.cli.ClaudeAccountSwitcher", return_value=switcher):
        _run_web_key(monkeypatch, ["set", "3", "--stdin"])

    out = capsys.readouterr().out
    assert out.strip() == "saved web key for account 3 (a@example.com)"
    assert SECRET not in out
    assert web_usage.get_key(tmp_path, "a@example.com") == SECRET

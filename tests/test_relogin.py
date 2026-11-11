"""``ccswap relogin`` renews a slot's login without switching accounts."""
import json
from pathlib import Path
from unittest.mock import patch

import pytest

from claude_swap import relogin as relogin_mod
from claude_swap.relogin import ReloginError, relogin
from claude_swap.switcher import ClaudeAccountSwitcher

OLD = json.dumps({"claudeAiOauth": {
    "accessToken": "at-old", "refreshToken": "rt-old",
    "expiresAt": 99999999999000, "refreshTokenExpiresAt": 1_000}})
NEW = json.dumps({"claudeAiOauth": {
    "accessToken": "at-new", "refreshToken": "rt-new",
    "expiresAt": 99999999999000, "refreshTokenExpiresAt": 1_900_000_000_000}})


def _add(s: ClaudeAccountSwitcher, email: str, org: str, slot: int) -> None:
    s._get_claude_config_path().write_text(json.dumps({"oauthAccount": {
        "emailAddress": email, "organizationUuid": org}}), encoding="utf-8")
    with patch.object(s, "_read_capture_credentials", return_value=OLD):
        s.add_account(slot=slot, assume_yes=True)


@pytest.fixture
def switcher(temp_home: Path, mock_claude_config: Path):
    s = ClaudeAccountSwitcher()
    s._setup_directories()
    s._init_sequence_file()
    _add(s, "me@example.com", "org-extra", 3)
    _add(s, "me@example.com", "org-product", 2)  # live account
    s._write_credentials(OLD)
    return s


def _login_as(email: str, org: str, creds: str = NEW, seen: list | None = None):
    def login(config_dir: str, hint: str) -> int:
        if seen is not None:
            seen.append((config_dir, hint))
        d = Path(config_dir)
        (d / ".claude.json").write_text(json.dumps({"oauthAccount": {
            "emailAddress": email, "organizationUuid": org}}))
        (d / ".credentials.json").write_text(creds)
        return 0
    return login


def test_inactive_slot_takes_the_new_login_and_the_live_one_is_untouched(switcher):
    seen: list = []
    result = relogin(switcher, "3", login=_login_as("me@example.com", "org-extra", seen=seen))

    assert switcher._read_account_credentials("3", "me@example.com") == NEW
    assert result.live_updated is False
    assert result.login_expires_at == "2030-03-17T17:46:40Z"
    assert json.loads(switcher._read_credentials())["claudeAiOauth"]["accessToken"] == "at-old"
    config_dir, hint = seen[0]
    assert hint == "me@example.com"
    assert not Path(config_dir).exists(), "the throwaway profile is removed"


def test_live_slot_also_replaces_what_claude_code_reads(switcher):
    result = relogin(switcher, "2", login=_login_as("me@example.com", "org-product"))

    assert result.live_updated is True
    assert switcher._read_account_credentials("2", "me@example.com") == NEW
    live = json.loads(switcher._read_credentials())["claudeAiOauth"]
    assert live["refreshToken"] == "rt-new"


def test_sign_in_to_the_other_organization_changes_nothing(switcher):
    with pytest.raises(ReloginError, match="org-extra"):
        relogin(switcher, "2", login=_login_as("me@example.com", "org-extra"))

    assert switcher._read_account_credentials("2", "me@example.com") == OLD
    assert switcher._read_account_credentials("3", "me@example.com") == OLD


def test_cancelled_sign_in_changes_nothing(switcher):
    with pytest.raises(ReloginError, match="cancelled"):
        relogin(switcher, "3", login=lambda _dir, _email: 1)

    assert switcher._read_account_credentials("3", "me@example.com") == OLD


def test_missing_claude_binary_is_reported(switcher, monkeypatch):
    monkeypatch.setattr(relogin_mod.shutil, "which", lambda _name: None)
    with pytest.raises(ReloginError, match="not on PATH"):
        relogin(switcher, "3")

"""``ccswap relogin``: renew a slot's login without switching accounts.

A slot's login is its refresh token, and the token server caps it at a fixed
date (``refreshTokenExpiresAt``) that refreshing never moves. Only a new
browser sign-in replaces it. This runs Claude Code's own ``claude auth login``
inside a throwaway ``CLAUDE_CONFIG_DIR``, so the sign-in lands in an isolated
profile instead of the live one, then moves the result into the slot once the
profile proves it is the same email and organization.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from claude_swap import macos_keychain, oauth
from claude_swap.exceptions import ClaudeSwitchError
from claude_swap.models import Platform
from claude_swap.session import (
    keychain_service_name,
    read_config_dir_credentials,
    read_session_identity,
)

LOGIN_TIMEOUT_S = 600


class ReloginError(ClaudeSwitchError):
    """The sign-in did not produce a login this slot may take; the slot is unchanged."""


@dataclass(frozen=True)
class ReloginResult:
    account_num: str
    email: str
    login_expires_at: str | None
    live_updated: bool


def run_claude_login(config_dir: str, email: str) -> int:
    """Run Claude Code's sign-in against ``config_dir``; its exit code."""
    claude = shutil.which("claude")
    if claude is None:
        raise ReloginError("Claude Code ('claude') is not on PATH")
    env = {**os.environ, "CLAUDE_CONFIG_DIR": config_dir}
    env.pop("CLAUDE_SECURESTORAGE_CONFIG_DIR", None)
    try:
        return subprocess.run(
            [claude, "auth", "login", "--claudeai", "--email", email],
            env=env,
            timeout=LOGIN_TIMEOUT_S,
        ).returncode
    except subprocess.TimeoutExpired as e:
        raise ReloginError(
            f"Sign-in did not finish within {LOGIN_TIMEOUT_S // 60} minutes"
        ) from e


def relogin(
    switcher,
    identifier: str,
    *,
    login: Callable[[str, str], int] = run_claude_login,
) -> ReloginResult:
    """Renew the login of the slot ``identifier`` names."""
    account_num, email, org_uuid = switcher.resolve_account(identifier)
    use_keychain = switcher._store._keychain_platform()
    config_dir = tempfile.mkdtemp(prefix="ccswap-relogin-")
    try:
        if login(config_dir, email) != 0:
            raise ReloginError("Sign-in was cancelled or failed")
        identity = read_session_identity(Path(config_dir))
        if identity is None:
            raise ReloginError("Sign-in finished without recording an account")
        if identity != (email, org_uuid or ""):
            got_email, got_org = identity
            raise ReloginError(
                f"Signed in as {got_email} in organization {got_org or 'personal'}, "
                f"not Account-{account_num}'s; nothing was changed. Run it again "
                "and pick that account's organization in the browser."
            )
        credentials = read_config_dir_credentials(
            config_dir, strict_keychain=True, use_keychain=use_keychain
        )
        if not credentials or not oauth.extract_oauth_data(credentials):
            raise ReloginError("Sign-in finished without storing a login")
        live_updated = switcher.replace_slot_login(
            account_num, email, org_uuid or "", credentials
        )
        return ReloginResult(
            account_num,
            email,
            oauth.login_expires_at_iso(credentials),
            live_updated,
        )
    finally:
        if use_keychain and Platform.detect() == Platform.MACOS:
            try:
                macos_keychain.delete_password(
                    keychain_service_name(config_dir),
                    macos_keychain.keychain_account_name(),
                )
            except macos_keychain.KEYCHAIN_ERRORS:
                pass
        shutil.rmtree(config_dir, ignore_errors=True)

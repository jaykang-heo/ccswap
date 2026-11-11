"""When to warn that a slot's login is about to lapse.

A login (``refreshTokenExpiresAt``) has a fixed end that refreshing never
moves, so the menu bar warns ahead of it at fixed distances and once per
distance. The record of what was sent is keyed by the expiry itself, so a
renewed login, which carries a new expiry, starts with a clean record.
"""

from __future__ import annotations

import json
import shlex
import sys
from dataclasses import dataclass
from pathlib import Path

from claude_swap import oauth

WARN_DAYS = (7, 3, 1)
DAY_S = 86400


@dataclass(frozen=True)
class SlotLogin:
    account_num: str
    email: str
    expires_at_ms: int


@dataclass(frozen=True)
class LoginWarning:
    login: SlotLogin
    days_left: float

    def message(self) -> str:
        n = self.login.account_num
        if self.days_left <= 0:
            when = "has expired"
        elif self.days_left < 1:
            when = f"expires in {max(1, round(self.days_left * 24))}h"
        else:
            when = f"expires in {int(self.days_left)}d"
        return (
            f"Account-{n} ({self.login.email}) login {when}. "
            f"Renew it from the menu, or run: ccswap relogin {n}"
        )


def slot_login(account_num: str, email: str, credentials: str | None) -> SlotLogin | None:
    data = oauth.extract_oauth_data(credentials) if credentials else None
    value = data.get("refreshTokenExpiresAt") if data else None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        return None
    return SlotLogin(account_num, email, int(value))


def terminal_relogin_argv(account_num: str, python: str = sys.executable) -> list[str]:
    """``osascript`` argv that runs ``ccswap relogin`` in a new Terminal window.

    The sign-in needs the login Keychain, which a launchd-started menu bar may
    not reach, and the person should see what the browser step asks of them.
    """
    command = " ".join(
        shlex.quote(part) for part in (python, "-m", "claude_swap", "relogin", account_num)
    )
    script = command.replace("\\", "\\\\").replace('"', '\\"')
    return [
        "/usr/bin/osascript",
        "-e", f'tell application "Terminal" to do script "{script}"',
        "-e", 'tell application "Terminal" to activate',
    ]


def days_left(login: SlotLogin, now_s: float) -> float:
    return (login.expires_at_ms / 1000 - now_s) / DAY_S


def due_warnings(
    logins: list[SlotLogin], sent: dict[str, int], now_s: float
) -> tuple[list[LoginWarning], dict[str, int]]:
    """Warnings to send now and the updated sent record.

    ``sent`` maps ``"<num>:<expires_at_ms>"`` to the smallest distance (in
    days) already warned about. Each login gets at most one warning per
    distance, and a login first seen inside several distances gets one.
    """
    record: dict[str, int] = {}
    due: list[LoginWarning] = []
    for login in logins:
        key = f"{login.account_num}:{login.expires_at_ms}"
        left = days_left(login, now_s)
        crossed = [d for d in WARN_DAYS if left <= d]
        last = sent.get(key)
        if crossed and (last is None or min(crossed) < last):
            due.append(LoginWarning(login, left))
            record[key] = min(crossed)
        elif last is not None:
            record[key] = last
    return due, record


def load_sent(path: Path) -> dict[str, int]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    return {k: v for k, v in raw.items() if isinstance(k, str) and isinstance(v, int)}


def save_sent(path: Path, sent: dict[str, int]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(sent, indent=2), encoding="utf-8")

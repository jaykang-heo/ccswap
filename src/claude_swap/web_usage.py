"""Usage from claude.ai's web endpoint, as a second source beside the OAuth one.

``api.anthropic.com/api/oauth/usage`` allows roughly 30 requests an hour per
account, so the OAuth poll cannot refresh faster than minutes. The claude.ai
web endpoint ``/api/organizations/{org}/usage`` returns the same JSON shape and
tolerates a far higher rate. It authenticates with the browser's ``sessionKey``
cookie, which the user pastes once per account email (``ccswap web-key set``).

Keys live in the macOS Keychain (service ``SERVICE``, account = email) or, on
other platforms, in ``<backup root>/web_keys.json`` with mode 0600. One key
covers every organization of its email. Keys are never logged or printed.

Readings are cached per account slot at ``<backup root>/cache/web_usage/<num>.json``:
``{"observedAt": epoch, "usage": {...}}`` on success, or
``{"observedAt": epoch, "error": kind, "retryAt": epoch?}`` on failure. The
collector refreshes stale caches (``TTL_S``) and overlays a reading that is
newer than the stored measurement. The overlay is read-model only.

Everything here degrades silently: without curl_cffi, or without a key, the
account keeps its OAuth-sourced usage.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import replace
from pathlib import Path

from claude_swap import macos_keychain, oauth
from claude_swap.fsutil import atomic_write_text
from claude_swap.usage_store import UsageEntry

SERVICE = "ccswap-web-session"
KEY_FILE_NAME = "web_keys.json"
# Names only (never key values): which emails have a key. Lets the collector skip
# the Keychain entirely for accounts without one, so a pass never spawns `security`
# just to learn that no web key exists.
INDEX_FILE_NAME = "web_keys_index.json"
DIR_NAME = "web_usage"
TTL_S = 20.0
# Same window as live_rate_limits: older readings no longer describe the account.
MAX_AGE_S = 6 * 3600.0
MAX_WORKERS = 4
# Short on purpose: this runs inside `ccswap list`, which must not stall on claude.ai.
TIMEOUT_S = 5
RETRY_FLOOR_S = 60.0
# How long a rejected key or a Cloudflare block stays parked before the next try.
# A bad key does not heal by itself, so retrying every TTL_S only adds requests.
INVALID_KEY_RETRY_S = 600.0
BLOCKED_RETRY_S = 300.0

ACCOUNT_URL = "https://claude.ai/api/account"
USAGE_URL = "https://claude.ai/api/organizations/{org_uuid}/usage"

_logger = logging.getLogger("claude-swap")


# -- key storage -------------------------------------------------------------


def _keychain_enabled() -> bool:
    return sys.platform == "darwin"


def _key_file(backup_root: Path) -> Path:
    return backup_root / KEY_FILE_NAME


def _read_file_keys(backup_root: Path) -> dict[str, str]:
    try:
        data = json.loads(_key_file(backup_root).read_text())
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, str)}


def _write_file_keys(backup_root: Path, keys: dict[str, str]) -> None:
    backup_root.mkdir(parents=True, exist_ok=True)
    atomic_write_text(_key_file(backup_root), json.dumps(keys, indent=2), mode=0o600)


def _read_index(backup_root: Path) -> set[str]:
    try:
        data = json.loads((backup_root / INDEX_FILE_NAME).read_text())
    except (OSError, ValueError):
        return set()
    emails = data.get("emails") if isinstance(data, dict) else None
    if not isinstance(emails, list):
        return set()
    return {e for e in emails if isinstance(e, str)}


def _write_index(backup_root: Path, emails: set[str]) -> None:
    backup_root.mkdir(parents=True, exist_ok=True)
    atomic_write_text(
        backup_root / INDEX_FILE_NAME, json.dumps({"emails": sorted(emails)}), mode=0o600
    )


def set_key(backup_root: Path, email: str, key: str) -> None:
    if _keychain_enabled():
        macos_keychain.set_password(SERVICE, email, key)
    else:
        keys = _read_file_keys(backup_root)
        keys[email] = key
        _write_file_keys(backup_root, keys)
    _write_index(backup_root, _read_index(backup_root) | {email})


def get_key(backup_root: Path, email: str) -> str | None:
    """The stored key, or None. A locked or unavailable Keychain reads as no key."""
    if _keychain_enabled():
        try:
            return macos_keychain.get_password(SERVICE, email)
        except macos_keychain.KeychainError:
            _logger.debug("web key lookup unavailable (keychain)")
            return None
    return _read_file_keys(backup_root).get(email)


def has_key(backup_root: Path, email: str) -> bool:
    """Whether a key was saved for ``email``. Reads the index, never the Keychain."""
    return email in _read_index(backup_root)


def remove_key(backup_root: Path, email: str, num: str | None = None) -> None:
    """Delete the key for ``email``; with ``num``, also drop that slot's cached reading."""
    if _keychain_enabled():
        macos_keychain.delete_password(SERVICE, email)
    else:
        keys = _read_file_keys(backup_root)
        if keys.pop(email, None) is not None:
            _write_file_keys(backup_root, keys)
    index = _read_index(backup_root)
    if email in index:
        _write_index(backup_root, index - {email})
    if num is not None:
        try:
            _cache_path(backup_root, num).unlink()
        except OSError:
            pass


# -- validation and fetch ----------------------------------------------------


def _requests():
    """curl_cffi's requests module; raises ImportError when the package is absent."""
    from curl_cffi import requests

    return requests


def _cookies(key: str) -> dict[str, str]:
    return {"sessionKey": key}


def validate_key(key: str) -> str | None:
    """The account email the key belongs to, or None when rejected or unreachable."""
    try:
        requests = _requests()
    except ImportError:
        return None
    try:
        resp = requests.get(
            ACCOUNT_URL, cookies=_cookies(key), impersonate="chrome", timeout=TIMEOUT_S
        )
    except Exception as exc:  # curl_cffi raises its own error hierarchy
        _logger.debug("web key validation failed: %s", type(exc).__name__)
        return None
    if resp.status_code != 200:
        return None
    try:
        data = resp.json()
    except ValueError:
        return None
    email = data.get("email_address") if isinstance(data, dict) else None
    return email if isinstance(email, str) and email else None


def _retry_after(resp) -> float | None:
    raw = resp.headers.get("Retry-After") if getattr(resp, "headers", None) else None
    if not raw:
        return None
    try:
        return max(0.0, float(str(raw).strip()))
    except ValueError:
        return None


def _header(resp, name: str) -> str:
    """Case-insensitive response header lookup; empty when absent."""
    headers = getattr(resp, "headers", None) or {}
    try:
        items = list(headers.items())
    except AttributeError:
        return ""
    for k, v in items:
        if isinstance(k, str) and k.lower() == name.lower() and isinstance(v, str):
            return v
    return ""


def _is_cloudflare_block(resp) -> bool:
    """A Cloudflare challenge page, which says nothing about the sessionKey."""
    if _header(resp, "Content-Type").lower().startswith("text/html"):
        return True
    text = getattr(resp, "text", "")
    return isinstance(text, str) and "Just a moment" in text


def _has_json_body(resp) -> bool:
    try:
        resp.json()
    except ValueError:
        return False
    return True


def fetch(org_uuid: str, key: str) -> tuple[dict | None, str | None, float | None]:
    """One web usage read: ``(usage, error_kind, retry_after_s)``. Never raises."""
    try:
        requests = _requests()
    except ImportError:
        return None, "web-unavailable", None
    url = USAGE_URL.format(org_uuid=org_uuid)
    try:
        resp = requests.get(url, cookies=_cookies(key), impersonate="chrome", timeout=TIMEOUT_S)
    except Exception as exc:
        _logger.debug("web usage request failed: %s", type(exc).__name__)
        return None, "network", None
    status = resp.status_code
    if status == 200:
        try:
            data = resp.json()
        except ValueError:
            return None, "bad-response", None
        try:
            usage = oauth.build_usage_result(data) if isinstance(data, dict) else None
        except (KeyError, TypeError, ValueError, AttributeError):
            usage = None
        if usage is None:
            return None, "bad-response", None
        return usage, None, None
    if status == 401:
        return None, "web-key-invalid", None
    if status == 403:
        # Cloudflare answers 403 with an HTML challenge; claude.ai answers a
        # rejected key with a JSON error. Only the latter condemns the key.
        if _is_cloudflare_block(resp):
            return None, "web-blocked", None
        if _has_json_body(resp):
            return None, "web-key-invalid", None
        return None, "http-403", None
    if status == 429:
        return None, "http-429", _retry_after(resp)
    return None, f"http-{status}", None


# -- cache -------------------------------------------------------------------


def _cache_dir(backup_root: Path) -> Path:
    return backup_root / "cache" / DIR_NAME


def _cache_path(backup_root: Path, num: str) -> Path:
    return _cache_dir(backup_root) / f"{num}.json"


def _num(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _read_cache(backup_root: Path, num: str) -> dict | None:
    try:
        data = json.loads(_cache_path(backup_root, num).read_text())
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _write_cache(backup_root: Path, num: str, payload: dict) -> None:
    _cache_dir(backup_root).mkdir(parents=True, exist_ok=True)
    atomic_write_text(_cache_path(backup_root, num), json.dumps(payload))


def refresh(backup_root: Path, accounts, now: float) -> None:
    """Fetch every keyed account whose cached reading is older than ``TTL_S``.

    ``accounts`` yields ``(num, email, org_uuid)``. An account inside its
    ``retryAt`` window (after a 429) is skipped. Results are written to the cache.
    """
    due: list[tuple[str, str, str]] = []
    indexed = _read_index(backup_root)
    for num, email, org_uuid in accounts:
        if not org_uuid or email not in indexed:
            continue
        num = str(num)
        cached = _read_cache(backup_root, num)
        if cached is not None:
            observed = _num(cached.get("observedAt"))
            if observed is not None and now - observed < TTL_S:
                continue
            retry_at = _num(cached.get("retryAt"))
            if retry_at is not None and now < retry_at:
                continue
        key = get_key(backup_root, email)
        if not key:
            continue
        due.append((num, org_uuid, key))
    if not due:
        return

    with ThreadPoolExecutor(max_workers=min(MAX_WORKERS, len(due))) as pool:
        futures = {pool.submit(fetch, org_uuid, key): num for num, org_uuid, key in due}
        for future in as_completed(futures):
            num = futures[future]
            try:
                usage, kind, retry_after = future.result()
            except Exception:
                usage, kind, retry_after = None, "error", None
            if usage is not None:
                payload = {"observedAt": now, "usage": usage}
            else:
                payload = {"observedAt": now, "error": kind or "error"}
                if kind == "http-429":
                    payload["retryAt"] = now + max(retry_after or RETRY_FLOOR_S, RETRY_FLOOR_S)
                elif kind == "web-key-invalid":
                    payload["retryAt"] = now + INVALID_KEY_RETRY_S
                elif kind == "web-blocked":
                    payload["retryAt"] = now + BLOCKED_RETRY_S
            _write_cache(backup_root, num, payload)
            _logger.debug("web usage refresh for account %s: %s", num, kind or "ok")


def load(backup_root: Path, now: float) -> dict[str, tuple[float, dict]]:
    """Fresh successful readings as ``{num: (observed_at, usage)}``."""
    try:
        paths = list(_cache_dir(backup_root).glob("*.json"))
    except OSError:
        return {}
    readings: dict[str, tuple[float, dict]] = {}
    for path in paths:
        try:
            data = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict):
            continue
        observed = _num(data.get("observedAt"))
        usage = data.get("usage")
        if observed is None or not isinstance(usage, dict):
            continue
        if 0 <= now - observed <= MAX_AGE_S:
            readings[path.stem] = (observed, usage)
    return readings


def overlay(
    entries: dict[str, UsageEntry],
    readings: dict[str, tuple[float, dict]],
    now: float,
) -> dict[str, UsageEntry]:
    """Entries with each newer web reading merged into ``last_good``.

    A reading applies only when it is newer than the entry's stored measurement
    and the entry carries no sentinel. Stored keys the web result lacks are kept.
    """
    out = dict(entries)
    for num, (observed, usage) in readings.items():
        entry = out.get(num)
        if entry is None or entry.sentinel is not None:
            continue
        if entry.fetched_at is not None and entry.fetched_at >= observed:
            continue
        merged = dict(entry.last_good or {})
        merged.update(usage)
        merged["source"] = "web"
        out[num] = replace(
            entry,
            last_good=merged,
            fetched_at=observed,
            age_s=max(0.0, now - observed),
        )
    return out


def status(backup_root: Path, accounts, now: float) -> list[dict]:
    """One row per account for ``web-key list``. Never includes key values."""
    rows: list[dict] = []
    for num, email, _org_uuid in accounts:
        num = str(num)
        cached = _read_cache(backup_root, num) or {}
        observed = _num(cached.get("observedAt"))
        rows.append(
            {
                "num": num,
                "email": email,
                "hasKey": has_key(backup_root, email),
                "observedAt": observed,
                "ageS": max(0.0, now - observed) if observed is not None else None,
                "error": cached.get("error") if isinstance(cached.get("error"), str) else None,
            }
        )
    return rows

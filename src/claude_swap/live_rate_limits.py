"""Live 5h/7d usage from Claude Code's statusline, overlaid on stored usage.

Claude Code hands every ``statusLine`` command the session's own
``rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}``, taken from
its API responses. Those numbers cost no usage-endpoint request, so they stay
current while the endpoint answers 429 and a polled measurement freezes.

A statusline drops each reading into ``<backup root>/cache/live_rate_limits/``,
one file per account. The file name is the reading's weekly reset in epoch
minutes: every account's weekly window resets at its own instant, so that
instant names the account without trusting which slot is active (a session
started before a switch keeps reporting its old account). One file per account
also means two sessions on different accounts never overwrite each other.

The collector overlays a reading on the one account whose stored weekly reset
is the same instant, when the reading is newer than the stored measurement.
The overlay is read-model only: the stored row, its poll plan and backoff stay
as the collector wrote them.

Writers: ``ccswap statusline`` (``record``) and any statusline script that
writes the same JSON shape (``{"observedAt": <epoch s>, "rate_limits": {...}}``).
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

from claude_swap.usage_store import UsageEntry

DIR_NAME = "live_rate_limits"
# A reading older than this no longer describes the account well enough to
# beat a stored measurement that failed to refresh; the stored one shows with
# its age note instead.
MAX_READING_AGE_S = 6 * 3600.0
# Stored resets come from the usage endpoint (…:59:59.96), statusline resets
# from response headers (whole seconds): the same instant within a minute.
_RESET_MATCH_S = 120.0
_PRUNE_AGE_S = 8 * 86400.0

_WINDOWS = ("five_hour", "seven_day")


def live_dir(backup_root: Path) -> Path:
    return backup_root / "cache" / DIR_NAME


def _num(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _reset_ts(window) -> float | None:
    if not isinstance(window, dict):
        return None
    raw = window.get("resets_at")
    if isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float)):
        return float(raw)
    if isinstance(raw, str):
        try:
            return datetime.fromisoformat(raw).timestamp()
        except ValueError:
            return None
    return None


def record(rate_limits: dict, backup_root: Path, now: float | None = None) -> Path | None:
    """Drop one statusline reading; returns its path, or None when unusable.

    Never raises: a statusline must always print.
    """
    try:
        weekly = rate_limits.get("seven_day") if isinstance(rate_limits, dict) else None
        reset = _reset_ts(weekly)
        if reset is None or _num(weekly.get("used_percentage")) is None:
            return None
        directory = live_dir(backup_root)
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / f"{int(reset // 60)}.json"
        tmp = directory / f".{target.name}.{os.getpid()}.tmp"
        payload = {
            "observedAt": time.time() if now is None else now,
            "rate_limits": {k: rate_limits[k] for k in _WINDOWS if isinstance(rate_limits.get(k), dict)},
        }
        tmp.write_text(json.dumps(payload))
        os.replace(tmp, target)
        return target
    except Exception:
        return None


def load(backup_root: Path, now: float) -> list[tuple[float, dict]]:
    """Fresh readings as ``(observed_at, rate_limits)``; prunes dead files."""
    directory = live_dir(backup_root)
    try:
        paths = list(directory.glob("*.json"))
    except OSError:
        return []
    readings: list[tuple[float, dict]] = []
    for path in paths:
        try:
            data = json.loads(path.read_text())
            observed = _num(data.get("observedAt"))
            rates = data.get("rate_limits")
        except (OSError, ValueError, AttributeError):
            continue
        if observed is None or not isinstance(rates, dict):
            continue
        age = now - observed
        if age > _PRUNE_AGE_S:
            try:
                path.unlink()
            except OSError:
                pass
            continue
        if 0 <= age <= MAX_READING_AGE_S:
            readings.append((observed, rates))
    return readings


def _window(live: dict, stored) -> dict | None:
    pct = _num(live.get("used_percentage"))
    if pct is None:
        return None
    window = {k: v for k, v in stored.items() if k not in ("countdown", "clock")} if isinstance(stored, dict) else {}
    window["pct"] = pct
    reset = _reset_ts(live)
    if reset is not None:
        window["resets_at"] = datetime.fromtimestamp(reset, tz=timezone.utc).isoformat()
    return window


def _overlay_one(entry: UsageEntry, observed: float, rates: dict, now: float) -> UsageEntry:
    usage = dict(entry.last_good or {})
    for key in _WINDOWS:
        live = rates.get(key)
        if isinstance(live, dict) and (window := _window(live, usage.get(key))) is not None:
            usage[key] = window
    return replace(entry, last_good=usage, fetched_at=observed, age_s=max(0.0, now - observed))


def overlay(
    entries: dict[str, UsageEntry], readings: list[tuple[float, dict]], now: float
) -> dict[str, UsageEntry]:
    """Entries with each reading applied to the account its weekly reset names.

    A reading applies only when exactly one account's stored weekly reset
    matches it and it is newer than that account's stored measurement; an
    entry carrying a sentinel (dead token, API key, …) keeps its state.
    """
    out = dict(entries)
    for observed, rates in sorted(readings, key=lambda r: r[0]):
        reset = _reset_ts(rates.get("seven_day"))
        if reset is None:
            continue
        matches = [
            num
            for num, entry in out.items()
            if entry.sentinel is None
            and isinstance(entry.last_good, dict)
            and (stored := _reset_ts(entry.last_good.get("seven_day"))) is not None
            and abs(stored - reset) <= _RESET_MATCH_S
        ]
        if len(matches) != 1:
            continue
        num = matches[0]
        entry = out[num]
        if entry.fetched_at is not None and entry.fetched_at >= observed:
            continue
        out[num] = _overlay_one(entry, observed, rates, now)
    return out

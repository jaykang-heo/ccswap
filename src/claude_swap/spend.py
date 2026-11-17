"""One spend plan for every Claude surface: which account to use first, and what each bar means.

The engine spends the account whose weekly window resets soonest first
(consume-first). Bars and hints read this plan instead of colouring raw used %,
so a soon-resetting account with quota left reads "use now", not "plenty left".
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

from claude_swap.settings import GateThresholds

SpendState = Literal["use_now", "next", "waiting", "blocked", "unknown"]
Tone = Literal["plain", "near", "limit"]

WASTE_WINDOW_S = 24 * 3600.0
WASTE_MIN_PCT = 10.0
NEAR_BELOW_GATE_PCT = 10.0


@dataclass(frozen=True)
class Spend:
    rank: int | None
    state: SpendState
    weekly_resets_at: float | None = None
    left_pct: float | None = None
    waste_pct: int | None = None
    blocked_until: float | None = None
    tones: dict[str, Tone] = field(default_factory=dict)

    def to_json(self) -> dict:
        return {
            "rank": self.rank,
            "state": self.state,
            "weeklyResetsAt": self.weekly_resets_at,
            "leftPct": self.left_pct,
            "wastePct": self.waste_pct,
            "blockedUntil": self.blocked_until,
            "tones": dict(self.tones),
        }


def spend_plan(
    rows: list[dict],
    *,
    strategy: str,
    gates: GateThresholds,
    now: float,
    models: tuple[str, ...] = (),
    windows: tuple[str, ...] = ("5h", "7d"),
) -> dict[int, Spend]:
    """Spend for every ``list --json`` row, keyed by account number."""
    from claude_swap.web_order import _claude_usage, order_accounts

    ordered = order_accounts("claude", rows, strategy=strategy, models=models, account_windows=windows)
    plan: dict[int, Spend] = {}
    usable_rank = 0
    for row in ordered:
        usage = _claude_usage(row) or {}
        tones = _tones(usage, gates)
        weekly = usage.get("seven_day") if isinstance(usage.get("seven_day"), dict) else {}
        reset = _ts(weekly.get("resets_at"))
        pct = weekly.get("pct")
        left = None if pct is None else max(0.0, 100.0 - float(pct))
        gating = {"5h", "7d"} | {m.lower() for m in models}
        blocked = [w for label, w in _windows(usage) if tones.get(label) == "limit" and label.lower() in gating]
        if row.get("disabled") or row.get("usageStatus") == "relogin_required" or not usage:
            plan[int(row["number"])] = Spend(None, "unknown", reset, left, tones=tones)
            continue
        if blocked:
            until = max((_ts(w.get("resets_at")) or now for w in blocked), default=None)
            plan[int(row["number"])] = Spend(None, "blocked", reset, left, blocked_until=until, tones=tones)
            continue
        usable_rank += 1
        state: SpendState = "use_now" if usable_rank == 1 else "next" if usable_rank == 2 else "waiting"
        waste = None
        if reset is not None and left is not None and reset - now <= WASTE_WINDOW_S and left >= WASTE_MIN_PCT:
            waste = round(left)
        plan[int(row["number"])] = Spend(usable_rank, state, reset, left, waste_pct=waste, tones=tones)
    return plan


def _windows(usage: dict) -> list[tuple[str, dict]]:
    out = []
    for key, label in (("five_hour", "5h"), ("seven_day", "7d")):
        if isinstance(usage.get(key), dict):
            out.append((label, usage[key]))
    for w in usage.get("scoped") or []:
        if isinstance(w, dict) and w.get("name"):
            out.append((str(w["name"]), w))
    return out


def _tones(usage: dict, gates: GateThresholds) -> dict[str, Tone]:
    tones: dict[str, Tone] = {}
    for label, w in _windows(usage):
        pct = w.get("pct")
        if pct is None:
            continue
        pct = float(pct)
        if pct >= 100.0:
            tones[label] = "limit"
        elif pct >= gates.for_label(label) - NEAR_BELOW_GATE_PCT:
            tones[label] = "near"
        else:
            tones[label] = "plain"
    return tones


def _ts(value) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None

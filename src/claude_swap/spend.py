"""One spend plan for every Claude surface: which account to use first, and what each bar means.

The engine spends the account whose weekly window resets soonest first
(consume-first). Bars and hints read this plan instead of colouring raw used %,
so a soon-resetting account with quota left reads "use now", not "plenty left".
"""

from __future__ import annotations

from dataclasses import dataclass, field
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
        raise NotImplementedError


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
    raise NotImplementedError

"""The default auto-switch spends the weekly quota that resets soonest first."""

import os
from pathlib import Path
from unittest.mock import patch

import pytest

from claude_swap.autoswitch import SwitchEvent, TickOutcome
from claude_swap.settings import AutoSwitchSettings
from tests.test_autoswitch import EngineHarness, _iso_at

H = 3600.0
DEFAULT = AutoSwitchSettings().strategy

# The fleet that wasted quota on 2026-11-17: (weekly used %, hours to weekly reset).
FLEET = {"1": (81.0, 91.0), "2": (68.0, 125.0), "3": (85.0, 60.0), "4": (71.0, 11.7)}


def _harness(home: Path, active: str, **settings) -> EngineHarness:
    h = EngineHarness(home, threshold=98.0, rebalance_pct=20.0, **settings)
    for n in FLEET:
        h.seed(int(n), f"{n}@x.com")
    h.make_live(f"{active}@x.com", int(active))
    return h


def _usage(p5: float, r5: float | None, p7: float, r7: float) -> dict:
    five: dict = {"pct": p5}
    if r5 is not None:
        five["resets_at"] = _iso_at(r5)
    return {"five_hour": five, "seven_day": {"pct": p7, "resets_at": _iso_at(r7)}}


def test_default_leaves_the_roomiest_account_for_the_one_resetting_soonest(temp_home):
    # Account 2 has the most room but resets last; 4 resets in under 12 hours.
    h = _harness(temp_home, "2", strategy=DEFAULT)
    now = h.clock.now
    outcome = h.tick_with_usage(
        {n: _usage(0.0, None, p7, now + hrs * H) for n, (p7, hrs) in FLEET.items()}
    )
    assert outcome is TickOutcome.SWITCHED
    sw = next(e for e in h.events if isinstance(e, SwitchEvent))
    assert sw.to_ref["number"] == 4, "default kept spending the account that resets last"


def _wasted_weekly_quota(home: Path, strategy: str) -> float:
    """Drive the real engine through a week of steady use and sum quota lost at reset."""
    h = _harness(home, "2", strategy=strategy)
    now0 = h.clock.now
    acc = {n: {"p7": p, "r7": now0 + hrs * H, "p5": 0.0, "r5": None} for n, (p, hrs) in FLEET.items()}
    burn7, burn5, step = 2.0, 12.0, 1800.0
    wasted = 0.0
    for _ in range(int(7 * 24 * H / step)):
        now = h.clock.now
        for a in acc.values():
            if now >= a["r7"]:
                wasted += 100.0 - a["p7"]
                a["p7"], a["r7"] = 0.0, a["r7"] + 7 * 24 * H
            if a["r5"] is not None and now >= a["r5"]:
                a["p5"], a["r5"] = 0.0, None
        h.tick_with_usage({n: _usage(a["p5"], a["r5"], a["p7"], a["r7"]) for n, a in acc.items()})
        a = acc[h.switcher.current_account_number()]
        used = max(0.0, min(burn7 * step / H, 100.0 - a["p7"], (100.0 - a["p5"]) * burn7 / burn5))
        if used:
            a["p7"] += used
            a["p5"] = min(100.0, a["p5"] + used * burn5 / burn7)
            if a["r5"] is None:
                a["r5"] = now + 5 * H
        h.clock.advance(step)
    return wasted


def _isolated_home(root: Path) -> Path:
    home = root / "home"
    (home / ".claude").mkdir(parents=True)
    return home


@pytest.mark.parametrize("strategy", ["best"])
def test_default_wastes_far_less_weekly_quota_than_best(tmp_path, strategy):
    results = {}
    for name in (DEFAULT, strategy):
        home = _isolated_home(tmp_path / name)
        with patch.dict(os.environ, {"HOME": str(home), "USERPROFILE": str(home)}), patch(
            "pathlib.Path.home", return_value=home
        ):
            results[name] = _wasted_weekly_quota(home, name)
    assert results[DEFAULT] * 2 < results[strategy], results

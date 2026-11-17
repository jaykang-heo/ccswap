"""Bar colours and hints follow one spend plan: the account to use first, and quota lost at reset."""

from datetime import datetime, timezone

from claude_swap.settings import AutoSwitchSettings, gate_thresholds
from claude_swap.spend import spend_plan

H = 3600.0
NOW = 1_795_000_000.0


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def _row(number: int, p5: float, h5: float | None, p7: float, h7: float, **extra) -> dict:
    five = {"pct": p5}
    if h5 is not None:
        five["resetsAt"] = _iso(NOW + h5 * H)
    return {
        "number": number,
        "usageStatus": "ok",
        "usage": {"fiveHour": five, "sevenDay": {"pct": p7, "resetsAt": _iso(NOW + h7 * H)}},
        **extra,
    }


# The 2026-11-17 13:53 screenshot the captain sent.
SCREENSHOT = [
    _row(1, 77, 1.6, 81, 91),    # killsolar2
    _row(2, 42, 3.8, 68, 125),   # leo.heo (unni-product)
    _row(3, 0, None, 85, 60),    # leo.heo (extra)
    _row(4, 44, 4.3, 78, 11.1),  # api-contract: resets in 11h with 22% left
]


def _plan(rows, **settings):
    s = AutoSwitchSettings(threshold=98.0, **settings)
    return spend_plan(rows, strategy=s.strategy, gates=gate_thresholds(s), now=NOW)


def test_the_screenshot_reads_use_now_on_the_account_whose_quota_would_be_lost():
    plan = _plan(SCREENSHOT)
    assert plan[4].state == "use_now" and plan[4].rank == 1
    assert plan[4].waste_pct == 22
    assert [plan[n].state for n in (3, 1, 2)] == ["next", "waiting", "waiting"]
    assert all(plan[n].waste_pct is None for n in (1, 2, 3))


def test_no_bar_is_a_limit_alarm_on_the_screenshot():
    plan = _plan(SCREENSHOT)
    tones = [t for n in plan for t in plan[n].tones.values()]
    assert "limit" not in tones


def test_a_spent_window_blocks_the_account_until_it_comes_back():
    rows = [_row(1, 100, 2.0, 50, 30), _row(2, 10, 4.0, 40, 100)]
    plan = _plan(rows)
    assert plan[1].state == "blocked" and plan[1].tones["5h"] == "limit"
    assert plan[1].blocked_until == NOW + 2.0 * H
    assert plan[2].state == "use_now"


def test_near_starts_ten_points_below_the_configured_switch_gate():
    rows = [_row(1, 88, 2.0, 50, 30), _row(2, 87, 2.0, 40, 100)]
    plan = _plan(rows)
    assert plan[1].tones["5h"] == "near"
    assert plan[2].tones["5h"] == "plain"


def test_a_spent_model_window_blocks_only_when_the_engine_watches_that_model():
    row = _row(1, 10, 2.0, 40, 30)
    row["usage"]["scoped"] = [{"name": "Fable", "pct": 100, "resetsAt": _iso(NOW + 30 * H)}]
    s = AutoSwitchSettings(threshold=98.0)
    unwatched = spend_plan([row], strategy=s.strategy, gates=gate_thresholds(s), now=NOW)
    watched = spend_plan([row], strategy=s.strategy, gates=gate_thresholds(s), now=NOW, models=("Fable",))
    assert unwatched[1].state == "use_now" and unwatched[1].tones["Fable"] == "limit"
    assert watched[1].state == "blocked"

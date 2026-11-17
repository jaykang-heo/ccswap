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


def test_the_tui_card_says_use_now_and_how_much_is_lost_at_reset():
    from claude_swap.models import AccountSnapshot
    from claude_swap.tui.widgets import account_card_text
    from claude_swap.usage_store import UsageEntry

    plan = _plan(SCREENSHOT)
    usage = {"five_hour": {"pct": 44.0, "resets_at": _iso(NOW + 4.3 * H)},
             "seven_day": {"pct": 78.0, "resets_at": _iso(NOW + 11.1 * H)}}
    acc = AccountSnapshot(
        number="4", email="api-contract@example.com", org_name="Org", org_uuid="u",
        is_active=True, kind="oauth", switchable=True,
        usage=UsageEntry(last_good=usage, fetched_at=NOW, age_s=0.0), spend=plan[4],
    )
    text = account_card_text(acc, 100, now=NOW).plain
    assert "USE NOW" in text
    assert "22% lost at reset in 11h" in text


# Adversarial findings (interrogate, 2026-11-17): the plan must match where the engine can land.

def test_an_account_past_its_switch_gate_is_never_use_now():
    # 95% weekly resets sooner, but the engine never lands above the gate (98 here).
    rows = [_row(1, 10, 4.0, 20, 100, active=True), _row(2, 0, None, 99, 10)]
    plan = _plan(rows)
    assert plan[2].state == "blocked"
    assert plan[1].state == "use_now"


def test_an_unknown_active_weekly_reset_keeps_the_active_account_first():
    active = _row(1, 10, 4.0, 20, 100, active=True)
    del active["usage"]["sevenDay"]["resetsAt"]
    plan = _plan([active, _row(2, 0, None, 30, 10)])
    assert plan[1].state == "use_now"
    assert plan[2].state == "next"


def test_when_nothing_can_be_landed_on_nothing_is_use_now():
    rows = [_row(1, 100, 1.0, 50, 100), _row(2, 99, 3.0, 40, 90)]
    plan = _plan(rows)
    assert {plan[1].state, plan[2].state} == {"blocked"}
    assert plan[1].blocked_until == NOW + 1.0 * H


def test_a_blocked_account_still_reports_weekly_quota_lost_at_reset():
    rows = [_row(1, 100, 2.0, 50, 2.0), _row(2, 10, 4.0, 40, 100)]
    plan = _plan(rows)
    assert plan[1].state == "blocked" and plan[1].waste_pct == 50


def test_blocked_until_counts_every_window_that_keeps_it_unlandable():
    # 5h back in 1h, but the weekly at 99% stays past the gate until its reset in 110h.
    rows = [_row(1, 100, 1.0, 99, 110), _row(2, 10, 4.0, 40, 100)]
    plan = _plan(rows)
    assert plan[1].blocked_until == NOW + 110 * H


def test_red_marks_the_window_that_blocks_not_the_weekly_bar_of_a_blocked_account():
    rows = [_row(1, 99, 2.9, 87, 9.7), _row(2, 10, 4.0, 40, 100)]
    plan = _plan(rows)
    assert plan[1].state == "blocked"
    assert plan[1].tones == {"5h": "limit", "7d": "plain"}


# Code review findings (kiro lane, 2026-11-17), each proven there by a run.

def test_a_window_the_engine_does_not_watch_never_blocks():
    rows = [_row(1, 10, 2.0, 99, 30), _row(2, 10, 3.0, 40, 100)]
    s = AutoSwitchSettings(threshold=98.0)
    plan = spend_plan(rows, strategy=s.strategy, gates=gate_thresholds(s), now=NOW, windows=("5h",))
    assert plan[1].state == "use_now"


def test_an_account_without_numbers_is_unknown_not_use_now():
    rows = [{"number": 1, "usageStatus": "ok", "usage": {"fiveHour": {}, "sevenDay": {}}},
            _row(2, 100, 3.0, 40, 100)]
    plan = _plan(rows)
    assert plan[1].state == "unknown" and plan[1].rank is None


def test_a_weekly_reset_already_past_is_not_waste():
    rows = [_row(1, 10, 2.0, 50, -1.0, active=True)]
    plan = _plan(rows)
    assert plan[1].waste_pct is None and plan[1].weekly_resets_at is None
    assert plan[1].state == "use_now"


def test_a_non_numeric_pct_is_ignored_not_a_crash():
    row = _row(1, 10, 2.0, 50, 30)
    row["usage"]["fiveHour"]["pct"] = "abc"
    plan = _plan([row])
    assert plan[1].state == "use_now" and "5h" not in plan[1].tones

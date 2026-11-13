from claude_swap import live_rate_limits
from claude_swap.menubar import usage_summary
from claude_swap.usage_store import UsageEntry

NOW = 1_794_536_517.0
WEEK_A = "2026-11-19T16:59:59.510638+00:00"  # ts 1795107599.51
WEEK_B = "2026-11-17T15:59:59.960733+00:00"


def stored(pct5, pct7, week, fetched_at, scoped=None):
    usage = {
        "five_hour": {"pct": pct5, "resets_at": "2026-11-13T05:29:59+00:00"},
        "seven_day": {"pct": pct7, "resets_at": week, "countdown": "6d", "clock": "Nov 20"},
    }
    if scoped:
        usage["scoped"] = scoped
    return UsageEntry(last_good=usage, fetched_at=fetched_at, age_s=NOW - fetched_at)


def statusline_rates(pct5, pct7, week_epoch):
    return {
        "five_hour": {"used_percentage": pct5, "resets_at": 1794547800},
        "seven_day": {"used_percentage": pct7, "resets_at": week_epoch},
    }


def test_statusline_reading_replaces_a_429_frozen_measurement(tmp_path):
    frozen = NOW - 79 * 60
    entries = {
        "3": stored(28.0, 5.0, WEEK_A, frozen, scoped=[{"name": "Fable", "pct": 0.0}]),
        "4": stored(0.0, 90.0, WEEK_B, NOW - 60),
    }
    assert live_rate_limits.record(statusline_rates(71.4, 9.0, 1795107600), tmp_path, now=NOW - 5)

    out = live_rate_limits.overlay(entries, live_rate_limits.load(tmp_path, NOW), NOW)

    assert out["3"].last_good["five_hour"]["pct"] == 71.4
    assert out["3"].last_good["seven_day"]["pct"] == 9.0
    assert out["3"].last_good["scoped"] == [{"name": "Fable", "pct": 0.0}]
    assert out["3"].age_s == 5
    assert out["4"] is entries["4"]
    assert "71%" in usage_summary(out["3"].last_good, NOW, out["3"].fetched_at)
    assert "ago" not in usage_summary(out["3"].last_good, NOW, out["3"].fetched_at)


def test_reading_for_an_unknown_week_changes_nothing(tmp_path):
    entries = {"4": stored(0.0, 90.0, WEEK_B, NOW - 600)}
    live_rate_limits.record(statusline_rates(50.0, 50.0, 1795000000), tmp_path, now=NOW)

    out = live_rate_limits.overlay(entries, live_rate_limits.load(tmp_path, NOW), NOW)

    assert out == entries


def test_reading_older_than_the_stored_measurement_is_ignored(tmp_path):
    entries = {"3": stored(30.0, 5.0, WEEK_A, NOW - 10)}
    live_rate_limits.record(statusline_rates(20.0, 4.0, 1795107600), tmp_path, now=NOW - 300)

    out = live_rate_limits.overlay(entries, live_rate_limits.load(tmp_path, NOW), NOW)

    assert out["3"].last_good["five_hour"]["pct"] == 30.0


def test_two_accounts_on_one_weekly_reset_are_not_guessed(tmp_path):
    entries = {"1": stored(1.0, 1.0, WEEK_A, NOW - 900), "2": stored(2.0, 2.0, WEEK_A, NOW - 900)}
    live_rate_limits.record(statusline_rates(60.0, 60.0, 1795107600), tmp_path, now=NOW)

    out = live_rate_limits.overlay(entries, live_rate_limits.load(tmp_path, NOW), NOW)

    assert out == entries


def test_unusable_statusline_input_writes_nothing(tmp_path):
    assert live_rate_limits.record({}, tmp_path) is None
    assert live_rate_limits.record({"seven_day": {"resets_at": 1795107600}}, tmp_path) is None
    assert live_rate_limits.load(tmp_path, NOW) == []

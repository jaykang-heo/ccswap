from claude_swap.vendors.core import AccountView, UsageResult, UsageState, UsageWindow
from claude_swap.vendors.overview import spend_key


def _row(alias, *windows, registered=True, state=UsageState.AVAILABLE):
    view = AccountView(tool="muse", alias=alias, kind="browser", registered=registered)
    return view, UsageResult(state, windows=tuple(windows))


def _w(key, pct, reset):
    return UsageWindow(key=key, label=key, unit="percent", used_percent=pct, resets_at=reset)


def test_tool_rows_lead_with_the_weekly_quota_that_expires_first():
    rows = [
        _row("roomy", _w("five-hour", 0, 50.0), _w("weekly", 10, 9_000.0)),
        _row("spent", _w("weekly", 100, 1_000.0)),
        _row("expiring", _w("five-hour", 20, 60.0), _w("weekly", 70, 2_000.0)),
        _row("unread", state=UsageState.ERROR),
        _row("unregistered", registered=False),
    ]
    assert [view.alias for view, _ in sorted(rows, key=spend_key)] == [
        "expiring", "roomy", "spent", "unread", "unregistered",
    ]

from claude_swap.web_order import order_accounts


def claude(number, pct=None, reset=None, **extra):
    usage = {
        "fiveHour": {"pct": pct, "resetsAt": reset},
        "sevenDay": {"pct": pct, "resetsAt": reset},
    } if pct is not None else None
    return {"number": number, "usageStatus": "ok" if usage else "unknown", "usage": usage, **extra}


def test_claude_strategies_order_available_exhausted_unknown_and_sentinel_accounts():
    rows = [
        claude(1, 65, "2030-02-01T00:00:00Z"),
        claude(2, 20, "2030-03-01T00:00:00Z"),
        claude(3, 100, "2030-04-01T00:00:00Z"),
        claude(4),
        claude(5, 2, "2030-01-01T00:00:00Z", disabled=True),
    ]
    best = order_accounts("claude", rows, strategy="best")
    consume = order_accounts("claude", rows, strategy="consume-first")
    assert [row["number"] for row in best] == [2, 1, 3, 4, 5]
    assert [row["rank"] for row in best] == [1, 2, 3, 4, 5]
    assert [row["number"] for row in consume] == [1, 2, 3, 4, 5]


def test_other_tool_accounts_rank_by_headroom_and_binding_reset_then_unknown():
    rows = [
        {"alias": "later", "usage": {"state": "available", "windows": [
            {"usedPercent": 10, "resetsAt": 200}, {"usedPercent": 35, "resetsAt": 300},
        ]}},
        {"alias": "first", "usage": {"state": "available", "windows": [
            {"usedPercent": 35, "resetsAt": 100},
        ]}},
        {"alias": "spent", "usage": {"state": "available", "windows": [
            {"unit": "credits", "used": 10, "limit": 10, "resetsAt": 50},
        ]}},
        {"alias": "unknown", "usage": {"state": "error", "error": "offline", "windows": []}},
    ]
    assert [row["alias"] for row in order_accounts("codex", rows)] == [
        "first", "later", "spent", "unknown"
    ]

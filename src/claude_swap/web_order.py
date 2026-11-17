"""Pure account ordering for the web dashboard."""

from __future__ import annotations

from datetime import datetime


def _number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _claude_usage(account):
    usage = account.get("usage") or account.get("lastGoodUsage")
    if not isinstance(usage, dict):
        return None
    names = {"fiveHour": "five_hour", "sevenDay": "seven_day"}
    result = {names.get(k, k): v for k, v in usage.items()}
    for key in ("five_hour", "seven_day", "weekly"):
        win = result.get(key)
        if isinstance(win, dict):
            result[key] = {**win, "pct": win.get("pct", win.get("usedPercent")),
                           "resets_at": win.get("resets_at", win.get("resetsAt"))}
    scoped = result.get("scoped")
    if isinstance(scoped, list):
        result["scoped"] = [{**w, "pct": w.get("pct", w.get("usedPercent")),
                              "resets_at": w.get("resets_at", w.get("resetsAt"))}
                             for w in scoped if isinstance(w, dict)]
    return result


def _claude_score(account, models, windows, strategy):
    from claude_swap.oauth import account_headroom
    from claude_swap.poll_policy import limiting_reset_ts

    usage = _claude_usage(account)
    headroom = account_headroom(usage, models, windows)
    binding_reset = limiting_reset_ts(usage, models, windows)
    weekly = usage.get("seven_day") if usage else None
    weekly_reset = None
    if isinstance(weekly, dict):
        try:
            weekly_reset = datetime.fromisoformat(str(weekly.get("resets_at", "")).replace("Z", "+00:00")).timestamp()
        except (TypeError, ValueError, OverflowError):
            pass
    sentinel = bool(account.get("disabled") or account.get("usageStatus") == "relogin_required")
    identity = str(account.get("number", account.get("alias", "")))
    if sentinel:
        return 4, 0, 0, identity
    if headroom is None:
        return 3, 0, 0, identity
    if headroom > 0:
        if strategy == "consume-first":
            return 0, weekly_reset if weekly_reset is not None else float("inf"), -headroom, identity
        return 0, -headroom, weekly_reset if weekly_reset is not None else float("inf"), identity
    return 1, binding_reset if binding_reset is not None else float("inf"), 0, identity


def _tool_score(account):
    usage = account.get("usage") or {}
    windows = usage.get("windows", []) if isinstance(usage, dict) else []
    scored = []
    for win in windows:
        if not isinstance(win, dict):
            continue
        used, limit = _number(win.get("used")), _number(win.get("limit"))
        pct = _number(win.get("usedPercent"))
        if pct is None and win.get("unit") == "credits" and used is not None and limit not in (None, 0):
            pct = used / limit * 100
        if pct is None and _number(win.get("remaining")) is not None:
            pct = 100 - win["remaining"]
        if pct is not None:
            scored.append((pct, _number(win.get("resetsAt"))))
    state = usage.get("state") if isinstance(usage, dict) else None
    failed = state in ("error", "stale") and bool(usage.get("error"))
    if not scored or failed:
        return 3, float("inf"), 0, str(account.get("alias", ""))
    max_pct = max(p for p, _ in scored)
    binding = [reset for pct, reset in scored if pct == max_pct and reset is not None]
    if max_pct < 100:
        # The longest window's reset is when unused quota is lost: spend it first.
        resets = [reset for _, reset in scored if reset is not None]
        return 0, max(resets, default=float("inf")), max_pct, str(account.get("alias", ""))
    return 1, min(binding, default=float("inf")), 0, str(account.get("alias", ""))


def order_accounts(tool, accounts, *, strategy="consume-first", models=(), account_windows=("5h", "7d")):
    """Return ranked account copies. Unknown data and Claude sentinels sort last."""
    key = (lambda a: _claude_score(a, models, account_windows, strategy)) if tool == "claude" else _tool_score
    ordered = sorted(accounts, key=key)
    return [{**account, "rank": index} for index, account in enumerate(ordered, 1)]

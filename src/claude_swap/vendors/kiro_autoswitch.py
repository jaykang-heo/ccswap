"""Quota-based switching of Kiro logins, on the Muse engine's policy.

Kiro reports one monthly plan-credit window per login. The engine treats it as
the long gate (``7d`` thresholds apply), so the same threshold, hysteresis,
cooldown and ``rebalancePct`` rules keep the roomiest Kiro login active.
"""

from __future__ import annotations

from claude_swap.exceptions import ClaudeSwitchError
from claude_swap.vendors.core import UsageResult, UsageState
from claude_swap.vendors.muse_autoswitch import LoginQuota, MuseAutoSwitchEngine
from claude_swap.vendors.service import VendorService

TOOL = "kiro"
_GATE_LABELS = {"monthly-credits": "7d"}


def _used(result: UsageResult) -> dict[str, float] | None:
    if result.state not in (UsageState.AVAILABLE, UsageState.STALE, UsageState.IDLE):
        return None
    used = {
        _GATE_LABELS[w.key]: w.used_percent
        for w in result.windows
        if w.key in _GATE_LABELS and w.used_percent is not None
    }
    return used or None


def login_quotas(service: VendorService) -> list[LoginQuota]:
    """Every registered Kiro login with its own usage, in menu order."""
    quotas: list[LoginQuota] = []
    for view in service.list_views(TOOL):
        if not view.registered or view.kind != "login":
            continue
        try:
            used = _used(service.usage(TOOL, view.alias))
        except ClaudeSwitchError:
            used = None
        quotas.append(
            LoginQuota(
                number=len(quotas) + 1,
                alias=view.alias,
                email=view.identity.get("email", ""),
                active=view.active is True,
                used=used,
            )
        )
    return quotas


class KiroAutoSwitchEngine(MuseAutoSwitchEngine):
    """Switch the signed-in Kiro login by the same policy as Muse."""

    tool = TOOL
    state_filename = "kiro_autoswitch_state.json"
    restart_hint = "Running Kiro sessions keep the previous login until restarted"

    @staticmethod
    def login_quotas(service: VendorService) -> list[LoginQuota]:
        return login_quotas(service)

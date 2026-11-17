"""Kiro logins switch by the Muse engine's policy, on the monthly plan-credit window."""

from __future__ import annotations

from types import SimpleNamespace

from claude_swap.autoswitch import TickOutcome
from claude_swap.settings import AutoSwitchSettings
from claude_swap.vendors.core import UsageResult, UsageState, UsageWindow
from claude_swap.vendors.kiro_autoswitch import KiroAutoSwitchEngine, _used
from claude_swap.vendors.muse_autoswitch import LoginQuota


class FakeService:
    def __init__(self, tmp_path):
        self.store = SimpleNamespace(root=tmp_path)
        self.switched: list[tuple[str, str]] = []

    def switch(self, tool, alias):
        self.switched.append((tool, alias))


def login(number, monthly, *, active=False, reset=None):
    return LoginQuota(
        number, f"k{number}", f"k{number}@example.com", active, {"7d": float(monthly)}, long_reset=reset
    )


def run(tmp_path, quotas, **settings):
    service = FakeService(tmp_path)
    events = []
    engine = KiroAutoSwitchEngine(
        service, AutoSwitchSettings(**settings), events.append, quotas=lambda: quotas, clock=lambda: 1_000.0
    )
    return engine.tick(), service, events


def test_spent_monthly_credits_move_to_the_login_with_room(tmp_path):
    outcome, service, events = run(tmp_path, [login(1, 100, active=True), login(2, 30)])
    assert outcome is TickOutcome.SWITCHED
    assert service.switched == [("kiro", "k2")]
    switch = next(e for e in events if e.kind == "switch")
    assert "Kiro" in switch.warnings[0]


def test_rebalance_keeps_the_roomiest_kiro_login_active(tmp_path):
    outcome, service, _ = run(tmp_path, [login(1, 60, active=True), login(2, 10)], rebalance_pct=20, strategy="best")
    assert outcome is TickOutcome.SWITCHED and service.switched == [("kiro", "k2")]


def test_every_login_spent_is_reported_not_switched(tmp_path):
    outcome, service, _ = run(tmp_path, [login(1, 100, active=True), login(2, 100)])
    assert outcome is TickOutcome.BLOCKED and service.switched == []


def test_the_monthly_credit_window_reads_as_the_long_gate():
    result = UsageResult(
        state=UsageState.AVAILABLE,
        windows=(UsageWindow(key="monthly-credits", label="Plan credits", unit="credits", used_percent=40.0),),
    )
    assert _used(result) == {"7d": 40.0}


def test_default_spends_the_login_whose_monthly_credits_reset_soonest(tmp_path):
    quotas = [login(1, 10, active=True, reset=9_000.0), login(2, 70, reset=2_000.0), login(3, 0, reset=5_000.0)]
    outcome, service, events = run(tmp_path, quotas)
    assert outcome is TickOutcome.SWITCHED and service.switched == [("kiro", "k2")]
    assert next(e for e in events if e.kind == "switch").trigger == "consume-first"


def test_default_stays_on_the_login_that_already_resets_soonest(tmp_path):
    quotas = [login(1, 70, active=True, reset=2_000.0), login(2, 0, reset=9_000.0)]
    outcome, service, _ = run(tmp_path, quotas)
    assert outcome is TickOutcome.NO_ACTION and service.switched == []

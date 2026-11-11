"""Quota-based switching of Muse browser logins, and the key a lane runs on."""

from __future__ import annotations

from types import SimpleNamespace

from claude_swap.autoswitch import TickOutcome
from claude_swap.settings import AutoSwitchSettings, gate_thresholds
from claude_swap.vendors.core import UsageResult, UsageState, UsageWindow
from claude_swap.vendors.muse_autoswitch import (
    LoginQuota,
    MuseAutoSwitchEngine,
    _used,
    roomiest,
)


def login(number, five, weekly, *, active=False, **extra):
    used = None if five is None else {"5h": float(five), "7d": float(weekly)}
    return LoginQuota(number, f"a{number}", f"a{number}@example.com", active, used, **extra)


class FakeService:
    def __init__(self, tmp_path):
        self.store = SimpleNamespace(root=tmp_path)
        self.switched: list[str] = []

    def switch(self, tool, alias):
        self.switched.append(alias)


def engine(tmp_path, quotas, *, now=None, **settings):
    service = FakeService(tmp_path)
    events = []
    built = MuseAutoSwitchEngine(
        service,
        AutoSwitchSettings(**settings),
        events.append,
        quotas=lambda: quotas,
        clock=(lambda: now[0]) if now else (lambda: 1_000.0),
    )
    return built, service, events


def reasons(events):
    return [e.reason for e in events if e.kind == "no-switch"]


def test_stays_put_below_every_gate(tmp_path):
    eng, service, events = engine(tmp_path, [login(1, 50, 60, active=True), login(2, 0, 0)])
    assert eng.tick() is TickOutcome.NO_ACTION
    assert service.switched == [] and reasons(events) == ["below-threshold"]


def test_weekly_at_the_limit_switches_to_the_login_with_most_room(tmp_path):
    quotas = [login(1, 2, 100, active=True), login(2, 0, 43), login(3, 10, 70)]
    eng, service, events = engine(tmp_path, quotas)
    assert eng.tick() is TickOutcome.SWITCHED
    assert service.switched == ["a2"]
    switch = next(e for e in events if e.kind == "switch")
    assert switch.trigger == "at-limit" and switch.to_ref["email"] == "a2@example.com"
    assert "restarted" in switch.warnings[0]


def test_proactive_switch_needs_a_target_clear_of_the_gate(tmp_path):
    near = [login(1, 92, 10, active=True), login(2, 85, 10)]
    eng, service, events = engine(tmp_path, near)
    assert eng.tick() is TickOutcome.BLOCKED
    assert service.switched == [] and reasons(events) == ["no-qualifying-candidate"]

    clear = [login(1, 92, 10, active=True), login(2, 40, 10)]
    eng, service, _ = engine(tmp_path, clear)
    assert eng.tick() is TickOutcome.SWITCHED and service.switched == ["a2"]


def test_proactive_switch_waits_out_the_cooldown_but_a_spent_login_does_not(tmp_path):
    now = [1_000.0]
    quotas = [login(1, 92, 10, active=True), login(2, 0, 10)]
    eng, service, events = engine(tmp_path, quotas, now=now)
    assert eng.tick() is TickOutcome.SWITCHED
    now[0] += 60
    assert eng.tick() is TickOutcome.NO_ACTION and reasons(events)[-1] == "cooldown"

    spent = [login(1, 100, 10, active=True), login(2, 0, 10)]
    eng, service, _ = engine(tmp_path, spent, now=now)
    assert eng.tick() is TickOutcome.SWITCHED and service.switched == ["a2"]


def test_never_switches_blind_or_onto_a_login_it_cannot_restore(tmp_path):
    eng, service, events = engine(tmp_path, [login(1, None, None, active=True), login(2, 0, 0)])
    assert eng.tick() is TickOutcome.NO_ACTION and reasons(events) == ["active-usage-unknown"]

    eng, service, events = engine(tmp_path, [login(1, 0, 0), login(2, 0, 0)])
    assert eng.tick() is TickOutcome.NO_ACTION and reasons(events) == ["no-active-account"]

    pointer = [login(1, 100, 0, active=True), login(2, 0, 0, restorable=False)]
    eng, service, events = engine(tmp_path, pointer)
    assert eng.tick() is TickOutcome.BLOCKED
    assert service.switched == [] and reasons(events) == ["no-candidates"]


def test_every_login_spent_is_reported_not_switched(tmp_path):
    eng, service, events = engine(tmp_path, [login(1, 100, 5, active=True), login(2, 3, 100)])
    assert eng.tick() is TickOutcome.BLOCKED
    assert service.switched == [] and events[-1].kind == "all-exhausted"


def test_dry_run_reports_the_switch_and_changes_nothing(tmp_path):
    service = FakeService(tmp_path)
    events = []
    eng = MuseAutoSwitchEngine(
        service,
        AutoSwitchSettings(),
        events.append,
        dry_run=True,
        quotas=lambda: [login(1, 100, 0, active=True), login(2, 0, 0)],
    )
    assert eng.tick() is TickOutcome.SWITCHED
    assert service.switched == [] and events[-1].dry_run is True


def test_a_gate_of_its_own_moves_one_window(tmp_path):
    quotas = [login(1, 10, 75, active=True), login(2, 0, 0)]
    eng, service, _ = engine(tmp_path, quotas, threshold_7d=70.0)
    assert eng.tick() is TickOutcome.SWITCHED and service.switched == ["a2"]


def test_roomiest_orders_by_the_nearest_gate_and_drops_spent_or_unread_logins():
    gates = gate_thresholds(AutoSwitchSettings())
    quotas = [login(1, 2, 100), login(2, 0, 43), login(3, 80, 10), login(4, None, None)]
    assert [q.alias for q in roomiest(quotas, gates)] == ["a2", "a3"]


def test_a_stale_reading_counts_and_a_bare_failure_does_not():
    windows = (
        UsageWindow("five-hour", "5-hour window", "percent", used_percent=0.0),
        UsageWindow("weekly", "Weekly", "percent", used_percent=43.0),
    )
    assert _used(UsageResult(UsageState.STALE, windows=windows)) == {"5h": 0.0, "7d": 43.0}
    assert _used(UsageResult(UsageState.UNAVAILABLE, "no allowance reported")) is None


def test_a_lane_runs_on_the_key_of_the_login_with_most_room(monkeypatch):
    from claude_swap.vendors import muse_autoswitch

    quotas = [
        login(1, 2, 100, active=True, key="KEY-SPENT"),
        login(2, 0, 43, key="KEY-ROOMY"),
        login(3, 0, 0),
    ]
    monkeypatch.setattr(muse_autoswitch, "login_quotas", lambda service: quotas)
    quota, key = muse_autoswitch.lane_key(object(), AutoSwitchSettings())
    assert (quota.alias, key) == ("a2", "KEY-ROOMY")

    spent = [login(1, 2, 100, key="K1"), login(2, None, None, key="K2")]
    monkeypatch.setattr(muse_autoswitch, "login_quotas", lambda service: spent)
    assert muse_autoswitch.lane_key(object(), AutoSwitchSettings()) is None

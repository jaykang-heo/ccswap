"""Quota-based switching for Muse browser logins, and the key a lane runs on.

Muse has one machine-wide login. The engine swaps it (``VendorService.switch``)
once the signed-in login reaches a gate, to the login with the most room left;
a running Muse session keeps the previous login until it is restarted. A lane
does not use that login: ``lane_key`` picks the subscription key of the login
with the most room, by the same policy, and changes nothing global.
"""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from claude_swap.autoswitch import (
    AllExhaustedEvent,
    AutoSwitchEvent,
    ErrorEvent,
    NoSwitchEvent,
    PollEvent,
    SwitchEvent,
    TickOutcome,
)
from claude_swap.exceptions import ClaudeSwitchError
from claude_swap.locking import FileLock
from claude_swap.settings import (
    AutoSwitchSettings,
    GateThresholds,
    atomic_write_json,
    gate_thresholds,
)
from claude_swap.vendors.core import UsageResult, UsageState
from claude_swap.vendors.muse import _login_restorable, _meta
from claude_swap.vendors.service import VendorService

TOOL = "muse"
STATE_FILENAME = "muse_autoswitch_state.json"
STATE_SCHEMA_VERSION = 1
RESTART_HINT = "Running Muse sessions keep the previous login until restarted"

# Muse's window keys, under the gate labels the autoswitch.* settings use.
_GATE_LABELS = {"five-hour": "5h", "weekly": "7d"}


@dataclass(frozen=True)
class LoginQuota:
    """One browser login as the policy sees it. ``used`` is None when no reading has numbers."""

    number: int
    alias: str
    email: str
    active: bool
    used: Mapping[str, float] | None  # gate label -> used percent
    restorable: bool = True  # ccswap holds a token it can write back
    key: str | None = None  # this login's subscription API key

    def margin(self, gates: GateThresholds) -> float | None:
        """Room below the nearest gate, in percent points; zero or less means a gate is reached."""
        if not self.used:
            return None
        return min(gates.for_label(label) - pct for label, pct in self.used.items())

    @property
    def exhausted(self) -> bool:
        return bool(self.used) and max(self.used.values()) >= 100.0

    @property
    def headroom(self) -> float | None:
        return None if not self.used else 100.0 - max(self.used.values())

    def ref(self) -> dict:
        return {"number": self.number, "email": self.email or self.alias}


def _used(result: UsageResult) -> dict[str, float] | None:
    # A stale reading is the login's last numbers with expired windows already rolled.
    if result.state not in (UsageState.AVAILABLE, UsageState.STALE):
        return None
    used = {
        _GATE_LABELS[w.key]: w.used_percent
        for w in result.windows
        if w.key in _GATE_LABELS and w.used_percent is not None
    }
    return used or None


def login_quotas(service: VendorService) -> list[LoginQuota]:
    """Every registered browser login with its own usage, in menu order."""
    if not any(record.kind == "browser" for record in service.store.records(TOOL)):
        return []  # nothing to measure: start no vendor process
    secrets = {record.alias: secret for record, secret in service._account_secrets(TOOL)}
    quotas = []
    for view in service.list_views(TOOL):
        if not view.registered or view.kind != "browser":
            continue
        try:
            used = _used(service.usage(TOOL, view.alias))
        except ClaudeSwitchError:
            used = None
        secret = secrets.get(view.alias) or ""
        key = (_meta(secret) or {}).get("api_key")
        quotas.append(
            LoginQuota(
                number=len(quotas) + 1,
                alias=view.alias,
                email=view.identity.get("email", ""),
                active=view.active is True,
                used=used,
                restorable=_login_restorable(secret),
                key=key if isinstance(key, str) and key.strip() else None,
            )
        )
    return quotas


def roomiest(quotas: Sequence[LoginQuota], gates: GateThresholds) -> list[LoginQuota]:
    """Logins that still have quota, most room below their nearest gate first."""
    usable = [q for q in quotas if q.used and not q.exhausted]
    return sorted(usable, key=lambda q: q.margin(gates), reverse=True)


def lane_key(service: VendorService, settings: AutoSwitchSettings) -> tuple[LoginQuota, str] | None:
    """The login a new lane should bill, with its subscription key; None when none is usable."""
    for quota in roomiest(login_quotas(service), gate_thresholds(settings)):
        if quota.key:
            return quota, quota.key
    return None


class MuseAutoSwitchEngine:
    """Switch the signed-in Muse login once it reaches a gate."""

    def __init__(
        self,
        service: VendorService,
        settings: AutoSwitchSettings,
        on_event: Callable[[AutoSwitchEvent], None],
        *,
        dry_run: bool = False,
        state_path: Path | None = None,
        clock: Callable[[], float] = time.time,
        quotas: Callable[[], list[LoginQuota]] | None = None,
    ) -> None:
        self.service = service
        self._quotas = quotas or (lambda: login_quotas(service))
        self.settings = settings
        self.on_event = on_event
        self.dry_run = dry_run
        self.state_path = state_path or (service.store.root / STATE_FILENAME)
        self.clock = clock
        self._stop = threading.Event()

    def _state_lock(self) -> FileLock:
        return FileLock(self.state_path.parent / ".muse_autoswitch_state.lock")

    def _read_state(self) -> dict:
        try:
            raw = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return raw if isinstance(raw, dict) else {}

    def _in_cooldown(self) -> bool:
        last = self._read_state().get("lastSwitchAt")
        return isinstance(last, (int, float)) and (
            self.clock() - last < self.settings.cooldown_seconds
        )

    def tick(self) -> TickOutcome:
        try:
            return self._tick()
        except Exception as exc:  # noqa: BLE001 - one bad tick must not end the loop
            self.on_event(ErrorEvent(message=f"{type(exc).__name__}: {exc}"))
            return TickOutcome.ERROR

    def _no(self, reason: str, detail: str = "", outcome=TickOutcome.NO_ACTION) -> TickOutcome:
        self.on_event(NoSwitchEvent(reason=reason, detail=detail))
        return outcome

    def _tick(self) -> TickOutcome:
        gates = gate_thresholds(self.settings)
        quotas = self._quotas()
        active = next((q for q in quotas if q.active), None)
        self.on_event(
            PollEvent(
                active=active.ref() if active else None,
                headroom={str(q.number): q.headroom for q in quotas},
                threshold=self.settings.threshold,
                windows={str(q.number): dict(q.used) for q in quotas if q.used},
            )
        )
        if active is None:
            return self._no(
                "no-active-account", "sign in and run 'ccswap muse add <alias> --browser' first"
            )
        margin = active.margin(gates)
        if margin is None:
            return self._no(
                "active-usage-unknown", "will not switch without a reading of the active login"
            )
        if margin > 0:
            label, pct = min(active.used.items(), key=lambda w: gates.for_label(w[0]) - w[1])
            return self._no(
                "below-threshold", f"{label} {pct:.0f}% < {gates.for_label(label):.0f}%"
            )
        trigger = "at-limit" if active.exhausted else "proactive"
        if trigger == "proactive" and self._in_cooldown():
            return self._no("cooldown")
        others = [q for q in quotas if not q.active and q.restorable]
        if not others:
            return self._no("no-candidates", outcome=TickOutcome.BLOCKED)
        qualifying = [
            q
            for q in roomiest(others, gates)
            # A proactive move must land clear of the gate, or two logins near it ping-pong.
            if trigger == "at-limit" or q.margin(gates) >= self.settings.hysteresis_pct
        ]
        if not qualifying:
            if all(q.exhausted for q in others):
                self.on_event(AllExhaustedEvent(earliest_reset_at=None))
                return TickOutcome.BLOCKED
            return self._no("no-qualifying-candidate", outcome=TickOutcome.BLOCKED)
        return self._perform(active, qualifying[0], trigger)

    def _perform(self, active: LoginQuota, target: LoginQuota, trigger: str) -> TickOutcome:
        event = SwitchEvent(
            trigger=trigger,
            from_ref=active.ref(),
            to_ref=target.ref(),
            warnings=[RESTART_HINT],
            dry_run=self.dry_run,
        )
        if self.dry_run:
            self.on_event(event)
            return TickOutcome.SWITCHED
        with self._state_lock():
            if trigger == "proactive" and self._in_cooldown():
                return self._no("cooldown")
            self.service.switch(TOOL, target.alias)
            state = self._read_state()
            state.update(
                schemaVersion=STATE_SCHEMA_VERSION,
                lastSwitchAt=self.clock(),
                lastSwitchTo=target.alias,
            )
            atomic_write_json(self.state_path, state)
        self.on_event(event)
        return TickOutcome.SWITCHED

    def stop(self) -> None:
        self._stop.set()

    def run_loop(self) -> int:
        self._stop.clear()
        while not self._stop.is_set():
            self.tick()
            self._stop.wait(self.settings.interval_seconds)
        return 0

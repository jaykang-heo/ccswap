from claude_swap.login_expiry import (
    DAY_S,
    SlotLogin,
    due_warnings,
    load_sent,
    save_sent,
    slot_login,
    terminal_relogin_argv,
)

NOW = 1_800_000_000.0


def _login(days: float, num: str = "2") -> SlotLogin:
    return SlotLogin(num, "me@example.com", int((NOW + days * DAY_S) * 1000))


def test_nothing_is_due_before_the_first_distance():
    due, sent = due_warnings([_login(10)], {}, NOW)
    assert due == [] and sent == {}


def test_each_distance_warns_once():
    login = _login(2.5)
    due, sent = due_warnings([login], {}, NOW)
    assert [w.login for w in due] == [login]
    assert due_warnings([login], sent, NOW) == ([], sent)

    later = NOW + 2 * DAY_S
    due, sent = due_warnings([login], sent, later)
    assert len(due) == 1 and "12h" in due[0].message()
    assert due_warnings([login], sent, later)[0] == []


def test_a_renewed_login_starts_a_clean_record():
    _, sent = due_warnings([_login(2)], {}, NOW)
    renewed = _login(30)
    due, sent = due_warnings([renewed], sent, NOW)
    assert due == [] and sent == {}


def test_expired_login_says_so():
    due, _ = due_warnings([_login(-1)], {}, NOW)
    assert "has expired" in due[0].message()
    assert "ccswap relogin 2" in due[0].message()


def test_sent_record_round_trips_and_survives_garbage(tmp_path):
    path = tmp_path / "sent.json"
    assert load_sent(path) == {}
    save_sent(path, {"2:1": 3})
    assert load_sent(path) == {"2:1": 3}
    path.write_text("not json")
    assert load_sent(path) == {}


def test_slot_login_reads_the_login_expiry_or_nothing():
    creds = '{"claudeAiOauth": {"refreshTokenExpiresAt": 5000}}'
    assert slot_login("2", "e", creds) == SlotLogin("2", "e", 5000)
    assert slot_login("2", "e", '{"claudeAiOauth": {}}') is None
    assert slot_login("2", "e", None) is None


def test_terminal_command_runs_relogin_for_the_slot():
    argv = terminal_relogin_argv("2", python="/opt/py thon")
    assert argv[0] == "/usr/bin/osascript"
    assert "'/opt/py thon' -m claude_swap relogin 2" in argv[2]

"""Regenerate the vendor-page screenshots in docs/screenshots/ from the current TUI.

    uv run python scripts/regen_screenshots.py [OUT_DIR]

Renders the overview, Muse and Kiro pages with Textual's ``save_screenshot``,
using the same synthetic fixtures as ``tests/test_vendors_tui.py`` (a fake
runner, no real Muse/Kiro login), with account masking turned on. Nothing is
read from or written to the developer's real home: $HOME and the XDG/Claude
config variables are pointed at a throwaway directory before ``claude_swap``
is imported.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO / "docs" / "screenshots"

_HOME = Path(tempfile.mkdtemp(prefix="ccswap-shots-"))
os.environ["HOME"] = str(_HOME)
for var in ("CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "XDG_DATA_HOME",
            "XDG_CONFIG_HOME", "META_API_KEY", "KIRO_API_KEY"):
    os.environ.pop(var, None)

sys.path[:0] = [str(REPO / "src"), str(REPO)]

from tests.test_tui import make_account, settle  # noqa: E402
import tests.test_vendors_tui as fixtures  # noqa: E402
from tests.test_vendors_tui import IDC, app_with, drain, goto, world  # noqa: E402
from claude_swap.vendors.core import AccountRecord  # noqa: E402

TITLE = "ccswap · {page} (synthetic data, masked)"
PAGES = (
    ("overview", "0", "tool-overview.svg"),
    ("muse", "3", "tool-muse.svg"),
    ("kiro", "4", "tool-kiro.svg"),
)
SIZE = (110, 46)  # the size of the committed screenshots (1360 x 1172 px)


async def shoot(workdir: Path, key: str, page: str, name: str) -> Path:
    svc, _ = world(workdir)
    svc.store.add(AccountRecord("kiro", "a", "login", identity=IDC))
    app = app_with(workdir, svc, [make_account(1, active=True)])
    app.title = TITLE.format(page=page)
    async with app.run_test(size=SIZE) as pilot:
        await settle(pilot)
        await goto(pilot, key)
        # Same route as the masking pilot test: turn masking on, then repaint the page.
        app.apply_mask(True)
        await drain(pilot)
        if hasattr(app.screen, "_paint"):
            app.screen._paint()
        await settle(pilot)
        return Path(app.save_screenshot(name, path=str(workdir)))


def fresh_fixtures() -> None:
    """Reset times relative to now, so the pages read as current (not "in 26710 days")."""
    import datetime as dt

    now = dt.datetime.now(dt.timezone.utc)
    ms = lambda d: int((now + d).timestamp() * 1000)  # noqa: E731
    fixtures.ALLOWANCE = {
        **fixtures.ALLOWANCE,
        "window": {"usedPercent": 34, "resetsAtMs": ms(dt.timedelta(hours=3))},
        "weekly": {"usedPercent": 7, "resetsAtMs": ms(dt.timedelta(days=4))},
        "asOfMs": ms(dt.timedelta(0)),
    }
    reset = (now + dt.timedelta(days=16)).strftime("%Y-%m-%d")
    fixtures.KIRO_REPORT = fixtures.KIRO_REPORT.replace("2099-12-01", reset)


async def main() -> None:
    fresh_fixtures()
    OUT.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="ccswap-shots-work-", dir=_HOME))
    try:
        for page, key, name in PAGES:
            target = work / page
            target.mkdir()
            shot = await shoot(target, key, page, name)
            shutil.copyfile(shot, OUT / name)
            print(f"wrote {OUT / name}")
    finally:
        shutil.rmtree(_HOME, ignore_errors=True)


if __name__ == "__main__":
    asyncio.run(main())

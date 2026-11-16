"""Long-running ccswap services follow a repin instead of running old code forever.

mise installs every pinned commit into its own ``installs/<name>-<commit>/``
folder and leaves the old folders in place. A service started from an old folder
(the menu bar that runs every auto-switch engine, the web dashboard) therefore
keeps running the old code after each repin, and a LaunchAgent written before
plists pinned the mise shim relaunches that same old folder. Measured
2026-11-16: the menu bar ran the 2026-11-13 install through 18 later commits.

Each service calls :func:`exit_if_superseded` from its loop. When the install
the shim now resolves to differs from the one this process imported from, it
re-installs a LaunchAgent that still pins a versioned path (so the relaunch runs
the new code) and exits non-zero, which launchd's ``KeepAlive`` restarts.
"""

from __future__ import annotations

import logging
import os
import re
import subprocess
import sys
import time
from pathlib import Path

_logger = logging.getLogger("claude-swap")

_INSTALL_DIR = re.compile(r"/mise/installs/([^/]+)/")
CHECK_EVERY_S = 300.0
SUPERSEDED_EXIT = 75  # EX_TEMPFAIL: launchd KeepAlive restarts a non-zero exit


def install_dir(path: str) -> str | None:
    """The ``installs/<dir>`` component of a mise install path, else None."""
    match = _INSTALL_DIR.search(path)
    return match.group(1) if match else None


def running_install() -> str | None:
    """The mise install this process imported claude_swap from."""
    return install_dir(str(Path(__file__).resolve()))


def current_install(timeout: float = 10.0) -> str | None:
    """The mise install the ``ccswap`` shim resolves to now, or None when unknown."""
    from claude_swap.launch_agent import _mise_shim

    shim = _mise_shim(str(Path(__file__).resolve()))
    if shim is None:
        return None
    mise = os.path.realpath(shim)
    try:
        found = subprocess.run(
            [mise, "which", "ccswap"],
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(Path.home()),
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if found.returncode != 0:
        return None
    return install_dir(found.stdout.strip())


def superseded() -> bool:
    """True when a repin made the shim point at a different install than this one."""
    running = running_install()
    current = current_install() if running else None
    return bool(running and current and running != current)


def _reinstall_detached(label: str) -> None:
    """Rewrite a LaunchAgent that still pins a versioned path, from a new session.

    ``install`` boots this very service out, so it runs in its own session to
    outlive that, and through the shim so it writes the shim into the plist.
    """
    from claude_swap import launch_agent

    plist = launch_agent.plist_path(label)
    try:
        pinned = plist.read_text(encoding="utf-8")
    except OSError:
        return
    shim = launch_agent._mise_shim(str(Path(__file__).resolve()))
    if shim is None or shim in pinned:
        return
    flag = {
        launch_agent.LABEL: ["menubar", "--install-service"],
        launch_agent.AUTO_LABEL: ["auto", "--install-service"],
        launch_agent.WEB_LABEL: ["web", "install"],
    }.get(label)
    if flag is None:
        return
    _logger.warning("%s pins a versioned install; re-installing it through %s", label, shim)
    subprocess.Popen(  # noqa: S603 - fixed argv
        [shim, *flag],
        start_new_session=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


class FreshnessCheck:
    """Rate-limited :func:`exit_if_superseded` for a service loop."""

    def __init__(self, label: str, every: float = CHECK_EVERY_S, clock=time.monotonic) -> None:
        self.label = label
        self.every = every
        self.clock = clock
        self._last = clock()

    def tick(self) -> None:
        now = self.clock()
        if now - self._last < self.every:
            return
        self._last = now
        exit_if_superseded(self.label)


def exit_if_superseded(label: str) -> None:
    """Exit for a relaunch on the current install when a repin replaced ours."""
    if not superseded():
        return
    _logger.warning(
        "%s runs install %s but ccswap now resolves to %s; exiting so launchd relaunches it",
        label,
        running_install(),
        current_install(),
    )
    _reinstall_detached(label)
    logging.shutdown()
    sys.stdout.flush()
    os._exit(SUPERSEDED_EXIT)

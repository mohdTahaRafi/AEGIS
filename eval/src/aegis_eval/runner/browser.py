"""Launches a persistent Chromium context with the unpacked AEGIS extension loaded.

Playwright's own bundled Chromium is used, not branded Chrome — branded Chrome builds have removed
the side-loading flags an unpacked extension needs (architecture.md §12.3, verify-at-setup note).
"""

from __future__ import annotations

import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from playwright.sync_api import BrowserContext, sync_playwright

REPO_ROOT = Path(__file__).resolve().parents[4]
EXTENSION_DIR = REPO_ROOT / "apps" / "extension" / ".output" / "chrome-mv3"


class ExtensionNotBuiltError(RuntimeError):
    pass


class ExtensionIdNotFoundError(RuntimeError):
    pass


def extension_id(context: BrowserContext, timeout_s: float = 10.0) -> str:
    """Reads the loaded extension's id from its background service worker's URL
    (`chrome-extension://<id>/background.js`) — the only place Playwright exposes it, since
    `--load-extension` assigns the id at load time rather than it being something this project's
    own build output records (phase_5_measurement.md §16a's harness-integration work)."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if context.service_workers:
            return context.service_workers[0].url.split("/")[2]
        time.sleep(0.1)
    raise ExtensionIdNotFoundError(
        "no background service worker appeared — is the extension actually loaded?"
    )


@contextmanager
def extension_context(headless: bool = True) -> Iterator[BrowserContext]:
    """A persistent Chromium context with the unpacked extension loaded.

    Extension loading requires launch_persistent_context (a plain launch() cannot load
    extensions) and the --load-extension / --disable-extensions-except flags. Modern Chromium's
    "new" headless mode (Playwright's default for headless=True since Chromium ~112) supports
    extension loading; the old headless mode did not.
    """
    if not EXTENSION_DIR.exists():
        raise ExtensionNotBuiltError(
            f"Extension build not found at {EXTENSION_DIR}. Run "
            "`pnpm --filter @aegis/extension build` first."
        )

    # Verified empirically (docs/planning/phase_1_contract_harness.md §13): Playwright's default
    # headless=True launches the "headless shell" binary, which does not support extension
    # loading at all. The documented workaround for extensions is headless=False (which selects
    # the full Chromium binary) combined with the raw --headless=new Chromium flag, which does
    # run genuinely headless — confirmed here by loading the real built extension and observing
    # its background service worker start with no display attached.
    launch_args = ["--headless=new"] if headless else []
    launch_args += [
        f"--disable-extensions-except={EXTENSION_DIR}",
        f"--load-extension={EXTENSION_DIR}",
    ]

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            user_data_dir="",  # empty string = Playwright manages an ephemeral profile dir
            headless=False,  # see comment above — real headlessness comes from --headless=new
            args=launch_args,
        )
        try:
            yield context
        finally:
            context.close()

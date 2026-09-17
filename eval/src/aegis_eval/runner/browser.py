"""Launches a persistent Chromium context with the unpacked AEGIS extension loaded.

Playwright's own bundled Chromium is used, not branded Chrome — branded Chrome builds have removed
the side-loading flags an unpacked extension needs (architecture.md §12.3, verify-at-setup note).
"""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from playwright.sync_api import BrowserContext, sync_playwright

REPO_ROOT = Path(__file__).resolve().parents[4]
EXTENSION_DIR = REPO_ROOT / "apps" / "extension" / ".output" / "chrome-mv3"


class ExtensionNotBuiltError(RuntimeError):
    pass


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

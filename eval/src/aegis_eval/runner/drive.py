"""Navigates fixture pages and drives real scripted tasks through the real panel.

Phase 1 built `open_fixture`/`list_fixtures` (open the fixture's local page, confirm it loaded).
Phase 5 (phase_5_measurement.md §16a) fills the real gap those functions' own doc comments named
but Phases 2-4 never closed: `run_task_in_panel` opens the extension's side panel as a real page
(Playwright has no dedicated "open the side panel" API — a side panel is just an extension page at
a known URL, so this navigates to it directly) and calls the `window.__aegisRunTask` hook
`entrypoints/sidepanel/main.tsx` exposes for exactly this purpose."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import time

from playwright.sync_api import BrowserContext, Page

CORPUS_DIR = Path(__file__).resolve().parents[4] / "eval" / "corpus"

# design.md §5.5's step-loop timeout budget is generous (network + model latency); a mock
# gateway response arrives near-instantly, so this only needs to cover real client-side work
# (extraction, detection, fusion, guard) plus a safety margin.
TASK_TIMEOUT_S = 15.0
HOOK_POLL_INTERVAL_S = 0.25


@dataclass
class FixtureOpenResult:
    screen_id: str
    split: str
    url: str
    title: str
    load_ms: float


class FixturePageMissingError(RuntimeError):
    pass


class PanelHookMissingError(RuntimeError):
    pass


def fixture_page_path(split: str, screen_id: str) -> Path:
    page_dir = CORPUS_DIR / split / screen_id / "page"
    index = page_dir / "index.html"
    if not index.exists():
        raise FixturePageMissingError(f"{index} does not exist")
    return index


def open_fixture(
    context: BrowserContext, split: str, screen_id: str, base_url: str | None = None
) -> tuple[FixtureOpenResult, Page]:
    """Returns both the load-timing result and the open `Page`, which the caller keeps open (and
    brings to the front before starting a task — see `run_task_in_panel`'s doc comment on why that
    matters) rather than closing immediately, unlike Phase 1's version of this function.

    `base_url` (T-6.10): pass `fixture_server.serve_corpus()`'s yielded URL to load the fixture
    over real HTTP instead of `file://` — required for the vision/image path to work at all (a
    `file://` origin can never be granted `captureVisibleTab` access; see `fixture_server.py`'s
    own doc comment for the real bug this was found fixing). `None` (the default) keeps the old
    `file://` behaviour for any caller that only needs the text/DOM path, unchanged."""
    index = fixture_page_path(split, screen_id)
    page = context.new_page()
    url = f"{base_url}/{split}/{screen_id}/page/index.html" if base_url else index.as_uri()
    start = time.perf_counter()
    page.goto(url, wait_until="load")
    load_ms = (time.perf_counter() - start) * 1000
    title = page.title()
    return FixtureOpenResult(screen_id=screen_id, split=split, url=url, title=title, load_ms=load_ms), page


def open_panel(context: BrowserContext, ext_id: str) -> Page:
    panel = context.new_page()
    panel.goto(f"chrome-extension://{ext_id}/sidepanel.html")
    deadline = time.monotonic() + TASK_TIMEOUT_S
    while time.monotonic() < deadline:
        if panel.evaluate("typeof window.__aegisRunTask") == "function":
            return panel
        time.sleep(HOOK_POLL_INTERVAL_S)
    raise PanelHookMissingError("window.__aegisRunTask never appeared — did the panel fail to load or mount?")


def run_task_in_panel(panel: Page, fixture_page: Page, task: str, canaries: list[str] | None = None) -> None:
    """`browser.tabs.query({active:true, currentWindow:true})` (the panel's own way of finding
    "the page to work on") returns whichever page was focused most recently in this window — under
    Playwright, opening the panel as a second `new_page()` can leave IT "active" rather than the
    fixture, which a real side panel (not a regular tab at all) would never contend for. Bringing
    the fixture page to front first is this harness's compensation for that Playwright-specific
    artifact, not something a real user ever has to think about.

    `canaries` (design.md §7.6 step 6, T-5.8): the screen's own labelled canary ids, so the guard's
    debug/harness-only check can catch exactly the residual-risk case a real end-to-end harness
    run against this project's real corpus found — a canary the pattern-based detectors' entropy
    heuristic happened not to flag (see docs/HISTORY.md's Phase 5 entry)."""
    fixture_page.bring_to_front()
    canaries_json = json.dumps(list(canaries or []))
    panel.evaluate(f"window.__aegisRunTask({task!r}, {canaries_json})")
    # `__aegisRunTask` resolves only once the whole task (including the mocked-or-real gateway
    # round trip and `gateway.closeSession`) has finished — waiting for the "Done"/"Error" label
    # rather than a fixed sleep confirms the panel actually reached a terminal state.
    panel.wait_for_function(
        "document.body.innerText.includes('Done') || document.body.innerText.includes('Error') || document.body.innerText.includes('Blocked')",
        timeout=TASK_TIMEOUT_S * 1000,
    )


def list_fixtures(split: str) -> list[str]:
    split_dir = CORPUS_DIR / split
    if not split_dir.exists():
        return []
    return sorted(p.name for p in split_dir.iterdir() if p.is_dir())

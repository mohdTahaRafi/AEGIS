"""Navigates fixture pages. Phase 1: open the fixture's local page and confirm it loaded — no
product task is scripted yet (that needs Phase 2's agent). Phase 2+ extends this to run the
scripted tasks named in each fixture's label `tasks[]` against the real agent."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import time

from playwright.sync_api import BrowserContext

CORPUS_DIR = Path(__file__).resolve().parents[4] / "eval" / "corpus"


@dataclass
class FixtureOpenResult:
    screen_id: str
    split: str
    url: str
    title: str
    load_ms: float


class FixturePageMissingError(RuntimeError):
    pass


def fixture_page_path(split: str, screen_id: str) -> Path:
    page_dir = CORPUS_DIR / split / screen_id / "page"
    index = page_dir / "index.html"
    if not index.exists():
        raise FixturePageMissingError(f"{index} does not exist")
    return index


def open_fixture(context: BrowserContext, split: str, screen_id: str) -> FixtureOpenResult:
    index = fixture_page_path(split, screen_id)
    page = context.new_page()
    try:
        url = index.as_uri()
        start = time.perf_counter()
        page.goto(url, wait_until="load")
        load_ms = (time.perf_counter() - start) * 1000
        title = page.title()
        return FixtureOpenResult(
            screen_id=screen_id, split=split, url=url, title=title, load_ms=load_ms
        )
    finally:
        page.close()


def list_fixtures(split: str) -> list[str]:
    split_dir = CORPUS_DIR / split
    if not split_dir.exists():
        return []
    return sorted(p.name for p in split_dir.iterdir() if p.is_dir())

"""Renders screenshot.png for every fixture, dev and held-out alike (eval/corpus/README.md's
documented layout). Run with: `uv run python -m aegis_eval.corpus.screenshot_fixtures`."""

from __future__ import annotations

from pathlib import Path

from playwright.sync_api import sync_playwright

CORPUS_ROOT = Path(__file__).resolve().parents[4] / "eval" / "corpus"
CORPUS_DEV = CORPUS_ROOT / "dev"
CORPUS_HELDOUT = CORPUS_ROOT / "heldout"


def main() -> None:
    roots = [root for root in (CORPUS_DEV, CORPUS_HELDOUT) if root.exists()]
    screen_dirs = sorted(
        (p for root in roots for p in root.iterdir() if p.is_dir()),
        key=lambda p: p.name,
    )
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, args=["--headless=new"])
        page = browser.new_page(viewport={"width": 1280, "height": 720})
        for screen_dir in screen_dirs:
            index = screen_dir / "page" / "index.html"
            if not index.exists():
                continue
            page.goto(index.as_uri())
            page.screenshot(path=str(screen_dir / "screenshot.png"))
        browser.close()
    print(f"[screenshot_fixtures] wrote screenshot.png for {len(screen_dirs)} fixtures")


if __name__ == "__main__":
    main()

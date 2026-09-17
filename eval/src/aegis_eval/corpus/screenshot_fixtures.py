"""Renders screenshot.png for every dev fixture (eval/corpus/README.md's documented layout).
Run with: `uv run python -m aegis_eval.corpus.screenshot_fixtures`."""

from __future__ import annotations

from pathlib import Path

from playwright.sync_api import sync_playwright

CORPUS_DEV = Path(__file__).resolve().parents[4] / "eval" / "corpus" / "dev"


def main() -> None:
    screen_ids = sorted(p.name for p in CORPUS_DEV.iterdir() if p.is_dir())
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, args=["--headless=new"])
        page = browser.new_page(viewport={"width": 1280, "height": 720})
        for screen_id in screen_ids:
            index = CORPUS_DEV / screen_id / "page" / "index.html"
            if not index.exists():
                continue
            page.goto(index.as_uri())
            page.screenshot(path=str(CORPUS_DEV / screen_id / "screenshot.png"))
        browser.close()
    print(f"[screenshot_fixtures] wrote screenshot.png for {len(screen_ids)} fixtures")


if __name__ == "__main__":
    main()

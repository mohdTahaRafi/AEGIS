"""Value-level label boxes: re-measures every text label to the rendered glyphs of its value.

generate_fixtures.py writes a label box per value-bearing *element* — for a sentence such as
"You can reach me at +91 70567 88035 anytime." that is the whole sentence. The client redacts
only the value's own characters (DOM Range boxes, CTC sub-line OCR boxes), which is the intended
behaviour (only the phone number is redacted, not the sentence around it), so an element-level
label scores a correct redaction as a miss plus a false alarm. This pass renders each fixture in
real Chromium, finds the substring of the text inside the old label box whose canonical form
hashes to the item's `value_hash` (or equals its `canary_id`), and replaces the box with the
rendered box of exactly that substring — a DOM Range for page text, the 2D context's own text
metrics for text drawn on a <canvas>.

Items it cannot place (pictures, <input> values, values not found) keep their box; the counts are
printed. Values stay hashed: plaintext exists only in the page being measured.

Run after generate_fixtures:
    eval/.venv/bin/python -m aegis_eval.corpus.value_boxes            # dev and heldout
    eval/.venv/bin/python -m aegis_eval.corpus.value_boxes --split dev
Held-out labels are rewritten by the same mechanical rule the generator applies to them; nothing
about their content is printed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from collections import Counter
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

REPO_ROOT = Path(__file__).resolve().parents[4]
CORPUS_ROOT = REPO_ROOT / "eval" / "corpus"
LABELS_DIR = REPO_ROOT / "eval" / "labels"

# Entities whose ground truth is a picture region, not a string of characters.
PICTURE_ENTITIES = {"FACE", "ID_DOCUMENT", "SIGNATURE", "QR_CODE"}

_DEVANAGARI_DIGITS = str.maketrans("०१२३४५६७८९", "0123456789")
# The generator's canonical forms (sha256_hash call sites): raw, lower-cased, spaces removed, and
# spaces plus "+" removed for phone numbers, separators removed for grouped ids ("1234-5678-9012"
# hashed as its digits) — each also with Devanagari digits folded to ASCII.
_MAX_VALUE_CHARS = 120

# Canvas text is not in the DOM: record every fillText/strokeText with the metrics needed to place
# any substring of it in page coordinates.
_CANVAS_HOOK = """
(() => {
  window.__aegisCanvasTexts = [];
  const proto = CanvasRenderingContext2D.prototype;
  for (const name of ['fillText', 'strokeText']) {
    const original = proto[name];
    proto[name] = function (text, x, y, maxWidth) {
      try {
        const s = String(text);
        const offsets = [];
        for (let i = 0; i <= s.length; i++) offsets.push(this.measureText(s.slice(0, i)).width);
        const m = this.measureText(s);
        const t = this.getTransform();
        window.__aegisCanvasTexts.push({
          canvas: this.canvas, text: s, x, y, align: this.textAlign, direction: this.direction,
          offsets, ascent: m.fontBoundingBoxAscent, descent: m.fontBoundingBoxDescent,
          m: [t.a, t.b, t.c, t.d, t.e, t.f],
        });
      } catch (e) { /* measurement is best-effort; drawing must not change */ }
      return original.call(this, text, x, y, maxWidth);
    };
  }
})();
"""

_COLLECT = """
(box) => {
  const [bx, by, bw, bh] = box;
  const slack = 3;
  const hits = (r) => r.width > 0 && r.height > 0 && r.left < bx + bw + slack && r.right > bx - slack
    && r.top < by + bh + slack && r.bottom > by - slack;
  if (!window.__aegisTextNodes) {
    const nodes = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const tag = n.parentElement && n.parentElement.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || !n.data.trim()) continue;
      nodes.push(n);
    }
    window.__aegisTextNodes = nodes;
  }
  const out = [];
  window.__aegisTextNodes.forEach((n, idx) => {
    const range = document.createRange();
    range.selectNodeContents(n);
    if ([...range.getClientRects()].some(hits)) out.push({ kind: 'dom', idx, text: n.data });
  });
  (window.__aegisCanvasTexts || []).forEach((t, idx) => {
    const r = window.__aegisCanvasBox(idx, 0, t.text.length);
    if (r && hits({ left: r[0], top: r[1], right: r[0] + r[2], bottom: r[1] + r[3], width: r[2], height: r[3] })) {
      out.push({ kind: 'canvas', idx, text: t.text });
    }
  });
  return out;
}
"""

_CANVAS_BOX = """
() => {
  window.__aegisCanvasBox = (idx, i, j) => {
    const t = window.__aegisCanvasTexts[idx];
    const c = t.canvas;
    if (!c.isConnected) return null;
    const rect = c.getBoundingClientRect();
    const sx = c.clientWidth / c.width;
    const sy = c.clientHeight / c.height;
    const total = t.offsets[t.offsets.length - 1];
    const rtl = t.direction === 'rtl';
    let start = 0;
    if (t.align === 'center') start = -total / 2;
    else if (t.align === 'right' || (t.align === 'end' && !rtl) || (t.align === 'start' && rtl)) start = -total;
    const x0 = t.x + start + t.offsets[i];
    const x1 = t.x + start + t.offsets[j];
    const y0 = t.y - t.ascent;
    const y1 = t.y + t.descent;
    const [a, b, cc, d, e, f] = t.m;
    const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([px, py]) => [a * px + cc * py + e, b * px + d * py + f]);
    const xs = pts.map((p) => rect.left + c.clientLeft + p[0] * sx);
    const ys = pts.map((p) => rect.top + c.clientTop + p[1] * sy);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
  };
}
"""

_MEASURE = """
([kind, idx, i, j]) => {
  if (kind === 'canvas') {
    const r = window.__aegisCanvasBox(idx, i, j);
    return r ? { box: r, lines: 1 } : null;
  }
  const n = window.__aegisTextNodes[idx];
  const range = document.createRange();
  range.setStart(n, i);
  range.setEnd(n, j);
  const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
  if (!rects.length) return null;
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.right));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  const lines = new Set(rects.map((r) => Math.round(r.top))).size;
  return { box: [left, top, right - left, bottom - top], lines };
}
"""


def _sha(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def _canonical_hashes(s: str) -> set[str]:
    forms = set()
    for base in (s, s.translate(_DEVANAGARI_DIGITS)):
        compact = base.replace(" ", "")
        forms.update((base, base.lower(), compact, compact.replace("+", ""), compact.replace("-", "")))
    return {_sha(f) for f in forms}


def find_value_span(text: str, value_hash: str | None, canary_id: str | None) -> tuple[int, int] | None:
    """The longest substring of `text` whose canonical form is the labelled value: longest so a
    phone keeps its "+91" when the hash dropped it. Substrings never start or end on whitespace."""
    best: tuple[int, int] | None = None
    n = len(text)
    for i in range(n):
        if text[i].isspace():
            continue
        for j in range(min(n, i + _MAX_VALUE_CHARS), i, -1):
            if text[j - 1].isspace():
                continue
            if best and j - i <= best[1] - best[0]:
                break
            s = text[i:j]
            if (canary_id and s == canary_id) or (value_hash and value_hash in _canonical_hashes(s)):
                best = (i, j)
                break
    return best


def _outward(box: list[float]) -> list[int]:
    x, y, w, h = box
    x0, y0 = math.floor(x), math.floor(y)
    return [x0, y0, math.ceil(x + w) - x0, math.ceil(y + h) - y0]


def refine_screen(page: Page, label: dict) -> Counter:
    counts: Counter = Counter()
    for item in label["items"]:
        entity = item["entity"]
        if entity in PICTURE_ENTITIES or entity == "NONE":
            counts["kept:picture-or-negative"] += 1
            continue
        if not item.get("value_hash") and not item.get("canary_id"):
            counts["kept:no-value"] += 1
            continue
        placed = None
        for cand in page.evaluate(_COLLECT, item["box"]):
            span = find_value_span(cand["text"], item.get("value_hash"), item.get("canary_id"))
            if span:
                placed = page.evaluate(_MEASURE, [cand["kind"], cand["idx"], span[0], span[1]])
                if placed:
                    counts[f"placed:{cand['kind']}"] += 1
                    if placed["lines"] > 1:
                        counts["placed:wrapped"] += 1
                    break
        if not placed:
            counts["kept:not-found"] += 1
            continue
        item["box"] = _outward(placed["box"])
    return counts


def _screen_dirs(splits: list[str]) -> list[Path]:
    return sorted(
        (p for split in splits if (CORPUS_ROOT / split).exists() for p in (CORPUS_ROOT / split).iterdir() if p.is_dir()),
        key=lambda p: p.name,
    )


def refine_labels(splits: list[str]) -> dict[str, Counter]:
    totals: dict[str, Counter] = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, args=["--headless=new"])
        page = browser.new_page(viewport={"width": 1280, "height": 720})
        page.add_init_script(_CANVAS_HOOK)
        for screen_dir in _screen_dirs(splits):
            index = screen_dir / "page" / "index.html"
            label_path = LABELS_DIR / f"{screen_dir.name}.json"
            if not index.exists() or not label_path.exists():
                continue
            label = json.loads(label_path.read_text())
            page.set_viewport_size({"width": label["viewport"][0], "height": label["viewport"][1]})
            page.goto(index.as_uri(), wait_until="load")
            page.evaluate("document.fonts.ready.then(() => true)")
            page.evaluate(_CANVAS_BOX)
            counts = refine_screen(page, label)
            totals.setdefault(screen_dir.parent.name, Counter()).update(counts)
            label_path.write_text(json.dumps(label, indent=2) + "\n")
        browser.close()
    return totals


def print_totals(totals: dict[str, Counter]) -> None:
    for split, counts in totals.items():
        print(f"[value_boxes] {split}: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--split", choices=["dev", "heldout", "all"], default="all")
    args = parser.parse_args()
    print_totals(refine_labels(["dev", "heldout"] if args.split == "all" else [args.split]))


if __name__ == "__main__":
    main()

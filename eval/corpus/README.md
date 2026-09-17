# eval/corpus

Labelled screens for the evaluation harness (design.md §18.1, FR-51).

- `dev/` — 80% of the corpus, used during development.
- `heldout/` — 20%, touched **once** before submission, only via an explicit runner flag that
  writes an audit line to the report (design.md §18.4). Do not open this folder casually.

Target: 200–300 screens across: government portals, banking, email/chat, social, healthcare,
canvas apps, PDF.js viewers, video/camera previews, Indic-script pages, hard negatives.

Each screen: `<screen_id>/page/` (saved page or render script), `screenshot.png` (reference
render at a fixed viewport), `meta.json` (category, script, viewport, source, licence, notes).
Labels live in `../labels/<screen_id>.json` — see design.md §18.1 for the exact shape. Fixture
identifiers must be synthetic with valid checksums (design.md §17); face images need a licence
that permits this use, recorded here per image.

**Empty — corpus build-out starts in Phase 1 (T-1.14, T-1.15) and completes in Phase 5 (T-5.1).**

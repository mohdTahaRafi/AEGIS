// design.md §7.6 step 6 (line 645) / phase_5_measurement.md T-5.8 — "debug/harness builds: for c
// in canaries: if contains(bytes or OCR(image), c): BLOCK(CANARY)." Canaries are unique
// high-entropy strings the eval corpus plants (`eval/src/aegis_eval/corpus/generate_fixtures.py`'s
// `CANARY` + 22 random chars) specifically because they have no recognizable pattern at all — no
// recognizer, structured or free-text, has any reason to catch one. A canary escaping is evidence
// of exactly the kind of blind spot no detector-list can enumerate in advance.
//
// Guard step 6 is inert in a normal build: it only fires when the caller supplies a non-empty
// canary list, which only the eval harness ever does (real user pages never contain a string that
// happens to match one of the harness's own randomly-generated canaries). No canary list is ever
// baked into the shipped policy or bundle.

export function checkForCanaries(bytes: string, canaries: readonly string[]): string | null {
  for (const canary of canaries) {
    if (canary.length > 0 && bytes.includes(canary)) return canary;
  }
  return null;
}

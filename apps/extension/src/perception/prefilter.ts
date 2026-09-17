// design.md §6.3 — the pre-filter that runs before the (expensive) NER model, so most text never
// reaches it. T-3.10's AC: "pre-filter rejects ≥80% of text before the model runs." This is real,
// independent of whether a real model is wired up on the other side (see
// `perception/models/pii-ner.ts`'s doc comment for that gap) — the filter's job is purely to cut
// volume, and that's fully testable without any model at all.

const CAPITALIZED_RUN_RE = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/;
const DIGIT_CLUSTER_RE = /\d{4,}/;
const GAZETTEER = ['street', 'road', 'avenue', 'colony', 'nagar', 'sector', 'district', 'state'];
const CONTEXT_LEXICON = ['name', 'address', 'contact', 'profile', 'account', 'phone', 'email', 'dob', 'birth'];

function matchesGazetteer(text: string): boolean {
  const lower = text.toLowerCase();
  return GAZETTEER.some((g) => lower.includes(g)) || CONTEXT_LEXICON.some((c) => lower.includes(c));
}

/** True if `text` should be sent to the NER model at all. A run of short, low-signal text (a
 * button label, a single lowercase word, a price) returns false — the majority case on a typical
 * page. */
export function shouldRunNer(text: string, insideFormOrProfileContainer = false): boolean {
  if (text.trim().length < 3) return false;
  if (insideFormOrProfileContainer) return true;
  if (CAPITALIZED_RUN_RE.test(text)) return true;
  if (DIGIT_CLUSTER_RE.test(text)) return true;
  if (matchesGazetteer(text)) return true;
  return false;
}

export function prefilterRejectionRate(samples: readonly { text: string; insideFormOrProfileContainer?: boolean }[]): number {
  if (samples.length === 0) return 0;
  const rejected = samples.filter((s) => !shouldRunNer(s.text, s.insideFormOrProfileContainer)).length;
  return rejected / samples.length;
}

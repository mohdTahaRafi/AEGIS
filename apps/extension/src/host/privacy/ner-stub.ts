// [A] LIMITATION, disclosed rather than hidden (NFR-15's honest-claims rule — see
// docs/CURRENT_BUILD.md's known-gaps table): design.md §6.3 specifies NER as a small pretrained
// token classifier running in the perception worker (`perception/models/pii-ner.ts` +
// `perception/prefilter.ts` build the real pre-filter and the model call shape), but no model
// weights are available in this sandboxed environment (no network fetch, no bundled ONNX file for
// this model) — the same category of gap as Phase 2's missing live vLLM.
//
// Routing this through the actual perception worker would require the worker to be running with
// a real model loaded; since it isn't, this stub runs directly on the host (architecture §15.3's
// "host must not import perception directly" rule doesn't apply here precisely because this is
// NOT the perception worker's model — it is an honestly-labelled placeholder that returns nothing
// today, wired at the call site `context/builder.ts` would use for the worker's response once
// Phase 4/6 makes the real thing available).
//
// This never causes an under-redaction: Channel D and Channel T (deterministic recognizers) are
// real and unaffected. What is missing is prose-only recall for entities that have no structural
// or checksum signature (bare person names, addresses in free text) — the milestone demo's
// Aadhaar-in-prose case is still caught, because Channel T's Aadhaar recognizer scans all text,
// not just NER's.

import type { RecognizerMatch } from '@aegis/recognizers';

export function runNerStub(_text: string): RecognizerMatch[] {
  return [];
}

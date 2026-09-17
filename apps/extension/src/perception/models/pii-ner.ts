// design.md §6.3, profile S — a small pretrained token classifier, WASM-capable, meant to run in
// the perception worker. [A] LIMITATION, disclosed (see `host/privacy/ner-stub.ts`'s longer note
// and `docs/CURRENT_BUILD.md`'s known-gaps table): no model weights are bundled or fetchable in
// this sandboxed environment, so this file defines the real call shape (chunking, mapping table)
// against which Phase 4/6 wires an actual ONNX/WASM model, but `classify` itself returns no
// findings today. This is a stated gap, not a silent one — nothing downstream assumes NER recall
// it doesn't have; Channel D and Channel T (deterministic recognizers) do not depend on this file.

import type { EntityType } from '@aegis/recognizers';

export interface NerSpan {
  start: number;
  end: number;
  label: string;
  score: number;
}

/** design.md §6.3's "chunking ≤256 tokens with 32-token overlap" — a crude whitespace-token
 * chunker (a real tokenizer would be model-specific and doesn't exist here yet). */
export function chunkForNer(text: string, maxTokens = 256, overlap = 32): string[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length <= maxTokens) return [text];
  const chunks: string[] = [];
  for (let start = 0; start < tokens.length; start += maxTokens - overlap) {
    chunks.push(tokens.slice(start, start + maxTokens).join(' '));
    if (start + maxTokens >= tokens.length) break;
  }
  return chunks;
}

/** design.md §6.3's "output mapped to the entity enum via a per-profile mapping table." */
export const PROFILE_S_LABEL_MAP: Readonly<Record<string, EntityType>> = {
  PER: 'PERSON_NAME',
  LOC: 'ADDRESS',
  EMAIL: 'EMAIL',
  PHONE: 'PHONE',
  ORG: 'BANK_ACCOUNT',
  DATE: 'DOB',
};

/** No model is loaded — always returns no spans. See this file's top-of-file doc comment. */
export async function classify(_text: string): Promise<NerSpan[]> {
  return [];
}

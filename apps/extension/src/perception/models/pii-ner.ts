// design.md §6.3 — free-text PII detection (Channel N). Two profiles:
// - Profile S: a small pretrained token classifier, WASM-capable. [A] LIMITATION, disclosed: no
//   such model is bundled or fetchable in this project (never was — see docs/DECISIONS.md's OQ-7
//   entry) — `classifyProfileS` always returns no findings. Channel D/T are unaffected.
// - Profile L: `openai/privacy-filter` (Apache-2.0, 1.5B total / 50M active MoE, 8 PII categories,
//   Transformers.js-ready) at 4-bit quantization, WebGPU-only. [Resolved 2026-09-26, see
//   docs/HISTORY.md] Real now: `apps/extension/public/models/privacy-filter/` bundles its
//   `onnx/model_q4.onnx(_data)` + tokenizer + config, fetched directly from the model's own HF repo
//   (verified reachable, no third-party mirror). `classifyProfileL` runs the real
//   `@huggingface/transformers` `token-classification` pipeline against it.
//
// Both profiles run inside the perception worker (`worker.ts`'s `handleNer`), not the host —
// profile L needs the worker's WebGPU backend probe/model-registry infra (T-4.x already built
// this for face/OCR/ViT), and profile S's call shape is symmetric with it even though it's inert.

import type { EntityType, RecognizerMatch } from '@aegis/recognizers';

/** design.md §6.3's "chunking ≤256 tokens with 32-token overlap" — kept for the call-shape design
 * describes, but NOT used by `classifyProfileL` below: `openai/privacy-filter`'s own config
 * reports `default_n_ctx: 128000`, real ORT/tokenizer introspection (2026-09-26) confirms every
 * free-text source this builder ever scans (a field label, a task string, one text run) is many
 * orders of magnitude under that — chunking would only ever fire on a pathological page, and would
 * cost this function's clean, single-pass character-offset recovery (see `locateSpan` below) for
 * no real benefit today. Left exported/tested against design.md's literal spec in case a future
 * model needs it. */
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

/** design.md §6.3's "output mapped to the entity enum via a per-profile mapping table." Profile S
 * never has real output to map (see this file's top comment), but the table is kept so the call
 * shape matches design.md's description exactly. */
export const PROFILE_S_LABEL_MAP: Readonly<Record<string, EntityType>> = {
  PER: 'PERSON_NAME',
  LOC: 'ADDRESS',
  EMAIL: 'EMAIL',
  PHONE: 'PHONE',
  ORG: 'BANK_ACCOUNT',
  DATE: 'DOB',
};

/** `openai/privacy-filter`'s real `id2label` tags (confirmed via its published `config.json`,
 * 2026-09-26), mapped onto this project's closed entity enum. `private_url` has no honest mapping
 * in the enum (a URL alone isn't one of design.md §3.3's sensitive categories) and is dropped —
 * this is a deliberate omission, not an oversight: adding a `URL` entity for one model's one label
 * is exactly the kind of scope creep CLAUDE.md's rule 7 asks not to do. */
export const PROFILE_L_LABEL_MAP: Readonly<Record<string, EntityType>> = {
  private_person: 'PERSON_NAME',
  private_address: 'ADDRESS',
  private_date: 'DOB',
  private_email: 'EMAIL',
  private_phone: 'PHONE',
  account_number: 'BANK_ACCOUNT',
  secret: 'SECRET',
};

/** No model is loaded for profile S — always returns no spans. See this file's top-of-file doc
 * comment. */
export async function classifyProfileS(_text: string): Promise<RecognizerMatch[]> {
  return [];
}

/** Minimal surface `classifyProfileL` needs from `@huggingface/transformers`'s pipeline, kept
 * narrow and dependency-free at the type level so this file (and its tests) don't need the real
 * package installed just to type-check the call shape. */
export type TokenClassificationPipeline = (
  text: string,
  options: { aggregation_strategy: 'simple'; ignore_labels: string[] },
) => Promise<{ entity_group: string; score: number; word: string }[]>;

/** `word` is the tokenizer's own re-decode of the grouped token span (see
 * `@huggingface/transformers`'s `groupEntities` — real source read, not assumed): it carries
 * whatever leading whitespace the original token boundary had, and is otherwise a verbatim
 * substring of `text` for this model/tokenizer (BPE with no lossy normalization for plain ASCII/
 * Unicode text). Locating it by an advancing `indexOf` (never rewinding `cursor`) is what keeps
 * repeated substrings (two people both named "Sam") mapped to their OWN occurrence in order,
 * matching the order the pipeline returned them in. Returns `null` — never a guessed range — if a
 * decode ever doesn't literally appear in `text` (e.g. a future tokenizer with lossy
 * normalization); a dropped span is the fail-closed choice here, not a wrong one. */
function locateSpan(text: string, word: string, cursor: number): { start: number; end: number } | null {
  const trimmed = word.trim();
  if (trimmed.length === 0) return null;
  const start = text.indexOf(trimmed, cursor);
  if (start === -1) return null;
  return { start, end: start + trimmed.length };
}

/** T-6.8, profile L, real: runs `openai/privacy-filter` (already loaded as `pipeline`, resident in
 * the perception worker's model registry — see `worker.ts`) over `text`, groups its BIOES tags via
 * the pipeline's own `aggregation_strategy: 'simple'`, recovers each group's character span against
 * the original `text` (the pipeline itself does not return offsets — confirmed by reading
 * `@huggingface/transformers`'s `TokenClassificationPipeline._call` source, which has its own
 * `// TODO: Add support for start and end` — this is not a version-specific quirk this file can
 * assume away), and maps recognized labels onto this project's entity enum via
 * `PROFILE_L_LABEL_MAP`. Unmapped labels (`private_url`) and unlocatable spans are dropped, never
 * guessed. `source` follows design.md §3.2's convention (`ner:<lowercase tag>`), `valid: true`
 * matches profile S's stub semantics (design.md: NER has no structural/checksum validator, unlike
 * Channel T's recognizers). */
export async function classifyProfileL(pipeline: TokenClassificationPipeline, text: string): Promise<RecognizerMatch[]> {
  const groups = await pipeline(text, { aggregation_strategy: 'simple', ignore_labels: ['O'] });
  const matches: RecognizerMatch[] = [];
  let cursor = 0;
  for (const group of groups) {
    const entity = PROFILE_L_LABEL_MAP[group.entity_group];
    if (!entity) continue;
    const span = locateSpan(text, group.word, cursor);
    if (!span) continue;
    cursor = span.end;
    matches.push({
      entity,
      start: span.start,
      end: span.end,
      matchedText: text.slice(span.start, span.end),
      score: group.score,
      source: `ner:${group.entity_group}`,
      valid: true,
    });
  }
  return matches;
}

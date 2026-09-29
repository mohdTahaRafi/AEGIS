// design.md §7.6 steps 3-4 — the two independent sweeps that give the guard its value. Step 3
// catches a substitution bug (a value the vault knows about but a *different* occurrence of it
// slipped through unsubstituted). Step 4 catches a detection bug (a value no channel ever found,
// so it never reached the vault at all). "Independent" means: different inputs (final serialized
// bytes, not DOM/candidates) at a different time (after substitution) — see design.md §7.2.

import type { SanitizedContext } from '@aegis/protocol';
import { ALL_RECOGNIZERS, findAll, normalizeForMatching, type EntityType } from '@aegis/recognizers';
import type { Policy, Sensitivity } from '@aegis/policy';
import { entityClass, threshold } from '@aegis/policy';
import type { Vault } from '../vault';
import { normalizedContains } from './normalize-contains';

export interface GuardBlock {
  rule: 'VAULT_LEAK' | 'PATTERN' | 'SCHEMA' | 'ID_SHAPE';
  entity?: EntityType;
}

const CLASS_ORDER: Sensitivity[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/** Sealed values this short are matched as whole tokens inside page-derived strings rather than
 * as raw substrings of the JSON bytes: a field classified by its label can seal "123" or "abc",
 * and a raw-bytes substring test would find "123" in any box coordinate and block every step. */
const SHORT_VALUE_MAX_LENGTH = 5;

/** JSON keys whose string values are protocol vocabulary or opaque ids, never page or user text. */
const STRUCTURAL_KEYS = new Set([
  'schema', 'step_id', 'delta_of', 'reason', 'category', 'status', 'id', 'role', 'frame', 'kind', 'entity',
  'ref', 'class', 'method', 'sources', 'affordances', 'level', 'sha256', 'data', 'mime', 'op',
]);
const PLACEHOLDER_TOKEN_RE = /⟪[A-Z_]+(?:#\d+)?⟫/g;

/** Every string in the payload that can carry page- or user-derived text, placeholders removed. */
export function payloadTextLeaves(payload: unknown): string[] {
  const out: string[] = [];
  const walk = (value: unknown, key: string | undefined): void => {
    if (key !== undefined && STRUCTURAL_KEYS.has(key)) return;
    if (typeof value === 'string') out.push(value.replace(PLACEHOLDER_TOKEN_RE, ' '));
    else if (Array.isArray(value)) for (const v of value) walk(v, undefined);
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, k);
  };
  walk(payload, undefined);
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsToken(haystack: string, normalizedNeedle: string): boolean {
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(normalizedNeedle)}(?![\\p{L}\\p{N}])`, 'u');
  return re.test(normalizeForMatching(haystack).toLowerCase());
}

/** Step 3: every value the vault knows about, searched for in the outgoing bytes. `textLeaves`
 * (from `payloadTextLeaves`) is where short values are searched instead — absent, every value is
 * checked against the raw bytes. */
export function vaultLeakSweep(vault: Vault, bytes: string, textLeaves?: readonly string[], unredactedRefs?: ReadonlySet<string>): GuardBlock | null {
  for (const normalized of vault.normalizedValues({ except: unredactedRefs })) {
    if (textLeaves && normalized.length > 0 && normalized.length <= SHORT_VALUE_MAX_LENGTH) {
      if (textLeaves.some((t) => containsToken(t, normalized))) return { rule: 'VAULT_LEAK' };
      continue;
    }
    if (normalizedContains(bytes, normalized)) {
      return { rule: 'VAULT_LEAK' };
    }
  }
  return null;
}

/** Step 4: recognizers where class ≥ HIGH run again, over the final payload's strings —
 * independently of whatever detected (or failed to detect) them the first time. Given
 * `textLeaves`, only those are scanned: the raw bytes also hold unrounded float box coordinates,
 * whose fractional digits pass as a Verhoeff-valid Aadhaar or an Indian mobile often enough to
 * block real pages (a scrolling ticker on passportindia.gov.in: `2399.562255859375`). */
export function patternResweep(policy: Policy, bytes: string, textLeaves?: readonly string[]): GuardBlock | null {
  const highOrAbove = new Set(['HIGH', 'CRITICAL']);
  const normalized = normalizeForMatching(textLeaves ? textLeaves.join('\n') : bytes);
  for (const recognizer of ALL_RECOGNIZERS) {
    const cls = entityClass(policy, recognizer.entity);
    if (!highOrAbove.has(cls)) continue;
    // The recognizer's own confidence counts, as it does in the builder: a bare date scores 0.3
    // (pass-through by policy; only a birth-date-labelled one is DOB), and blocking on it blocked
    // every date-bearing page while the builder, correctly, left it alone.
    const floor = threshold(policy, cls);
    for (const match of recognizer.find(normalized)) {
      if (match.valid && match.score >= floor) {
        return { rule: 'PATTERN', entity: recognizer.entity };
      }
    }
  }
  return null;
}

export function classAtLeast(a: Sensitivity, b: Sensitivity): boolean {
  return CLASS_ORDER.indexOf(a) >= CLASS_ORDER.indexOf(b);
}

const OCR_WINDOW = 5;

function alnum(text: string): string {
  return normalizeForMatching(text).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** Guard step 5's text criterion for OCR read around a redaction box: a valid HIGH+ recognizer
 * match, or any 5-character run shared with a sealed vault value (a partly visible value, e.g. a
 * digit tail escaping its box). Field labels ("Aadhaar", "Mobile") are neither. OCR text never
 * leaves the device and is never logged. */
export function isSensitiveOcrText(policy: Policy, vault: Vault, text: string): boolean {
  if (patternResweep(policy, text, [text])) return true;
  const read = alnum(text);
  if (read.length < OCR_WINDOW) return false;
  for (const normalized of vault.normalizedValues()) {
    const value = alnum(normalized);
    if (value.length < OCR_WINDOW) continue;
    for (let i = 0; i + OCR_WINDOW <= read.length; i++) {
      if (value.includes(read.slice(i, i + OCR_WINDOW))) return true;
    }
  }
  return false;
}

const SCRUB_MARKER = '⟪UNKNOWN_SENSITIVE⟫';

function scrubString(text: string, policy: Policy, vault: Vault, strict: boolean): string {
  if (!text) return text;
  const normalized = normalizeForMatching(text);
  const matches = findAll(normalized)
    .filter((m) => m.valid && entityClass(policy, m.entity) !== 'LOW' && (strict || m.score >= threshold(policy, entityClass(policy, m.entity))))
    .sort((a, b) => b.start - a.start);
  let out = normalized;
  let lastStart = Infinity;
  for (const m of matches) {
    if (m.end > lastStart) continue; // overlapping: the later (already replaced) one covers it
    out = `${out.slice(0, m.start)}⟪${m.entity}⟫${out.slice(m.end)}`;
    lastStart = m.start;
  }
  // A vault value still present (a variant spelling no recognizer parses): the string goes as a
  // bare marker — its placeholders are kept, its page text is not.
  const bare = out.replace(PLACEHOLDER_TOKEN_RE, ' ');
  for (const value of vault.normalizedValues()) {
    if (value.length >= 3 && containsToken(bare, value)) {
      const kept = out.match(PLACEHOLDER_TOKEN_RE) ?? [];
      return [SCRUB_MARKER, ...kept].join(' ');
    }
  }
  return out;
}

function scrubLeaves(value: unknown, key: string | undefined, fn: (s: string) => string): unknown {
  if (key !== undefined && STRUCTURAL_KEYS.has(key)) return value;
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => scrubLeaves(v, undefined, fn));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubLeaves(v, k, fn)]));
  return value;
}

/** The payload with every recognizer match (and every vault value) in its page- and user-derived
 * text replaced by a bare marker. Only used after the guard — or the gateway's own tripwire —
 * refused the payload as built: the step then goes out with that text sealed instead of the task
 * ending. `strict` also seals matches below the policy's confidence threshold (the gateway's
 * tripwire flagged something the local threshold let pass). The image is untouched: it is
 * re-checked separately. */
export function scrubPayloadText(payload: SanitizedContext, policy: Policy, vault: Vault, strict = false): SanitizedContext {
  const { image, ...rest } = payload;
  const scrubbed = scrubLeaves(rest, undefined, (s) => scrubString(s, policy, vault, strict)) as Omit<SanitizedContext, 'image'>;
  return { ...scrubbed, image } as SanitizedContext;
}

function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `textLeaves` with every value the user un-redacted removed (any spacing for digit values), so
 * the pattern re-sweep does not refuse what the user explicitly chose to share. */
export function withoutUnredacted(textLeaves: readonly string[], vault: Vault, unredactedRefs: ReadonlySet<string> | undefined): string[] {
  if (!unredactedRefs || unredactedRefs.size === 0) return [...textLeaves];
  const patterns = [...vault.normalizedValues({ only: unredactedRefs })]
    .filter((v) => v.length > 0)
    .map((v) => new RegExp(/^\d+$/.test(v) ? v.split('').join('[\\s\\-.]?') : escapeForRegExp(v), 'giu'));
  return textLeaves.map((t) => patterns.reduce((acc, re) => acc.replace(re, ' '), normalizeForMatching(t)));
}

// design.md §7.6 steps 3-4 — the two independent sweeps that give the guard its value. Step 3
// catches a substitution bug (a value the vault knows about but a *different* occurrence of it
// slipped through unsubstituted). Step 4 catches a detection bug (a value no channel ever found,
// so it never reached the vault at all). "Independent" means: different inputs (final serialized
// bytes, not DOM/candidates) at a different time (after substitution) — see design.md §7.2.

import { ALL_RECOGNIZERS, normalizeForMatching, type EntityType } from '@aegis/recognizers';
import type { Policy, Sensitivity } from '@aegis/policy';
import { entityClass } from '@aegis/policy';
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
export function vaultLeakSweep(vault: Vault, bytes: string, textLeaves?: readonly string[]): GuardBlock | null {
  for (const normalized of vault.normalizedValues()) {
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
    if (!highOrAbove.has(entityClass(policy, recognizer.entity))) continue;
    for (const match of recognizer.find(normalized)) {
      if (match.valid) {
        return { rule: 'PATTERN', entity: recognizer.entity };
      }
    }
  }
  return null;
}

export function classAtLeast(a: Sensitivity, b: Sensitivity): boolean {
  return CLASS_ORDER.indexOf(a) >= CLASS_ORDER.indexOf(b);
}

// design.md §7.6 — the egress guard, the single choke point. Runs on the final serialized bytes,
// independently of whatever produced them (§7.2). T-3.22-3.25. Replaces the Phase-2 stub
// (T-3.26) — there is no path from here that returns an unbranded payload or a payload that
// skipped a step.

import type { SanitizedContext } from '@aegis/protocol';
import { validators } from '@aegis/protocol';
import type { Policy } from '@aegis/policy';
import { brand, type GuardedPayload } from '../../egress/brand';
import type { Vault } from '../vault';
import type { Box } from '../types';
import { patternResweep, payloadTextLeaves, vaultLeakSweep } from './sweeps';
import { runImageRescan, type ImageRescanDeps } from './image-rescan';
import { checkForCanaries } from './canary';

export class GuardBlockedError extends Error {
  constructor(public readonly rule: 'SCHEMA' | 'ID_SHAPE' | 'VAULT_LEAK' | 'PATTERN' | 'CANARY', public readonly entity?: string) {
    super(`GUARD_BLOCK_${rule}`);
    this.name = 'GuardBlockedError';
  }
}

export interface GuardDeps {
  /** Absent when there is no image to rescan (the common L0 case) or no perception worker
   * available at all. Step 5 fails closed either way: a payload that carries an image but has no
   * way to independently re-check it never ships that image — see `guard()`'s image branch. */
  imageRescan?: ImageRescanDeps;
  /** design.md §7.6 step 6 / T-5.8: "debug/harness builds" only — absent (the production default)
   * means this step never runs at all. Only the eval harness ever supplies a non-empty list (its
   * own planted high-entropy strings — `eval/src/aegis_eval/corpus/generate_fixtures.py`); no
   * canary is ever baked into the shipped policy or bundle. Checked against the JSON bytes only —
   * checking a composed image needs OCR, a Phase 6 capability (`perception/rescan/halo.ts`'s
   * disclosed gap applies equally here). */
  canaries?: readonly string[];
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** design.md §7.6 step 5 (phase_4_vision.md §8): two independent checks on the *composed* image,
 * not the input. `dropped` and `no-rescan-capability` both fall back to L0 by stripping the image
 * — "degrading to a text-only payload is always available and always safe; sending a questionable
 * image is not" (phase_4_vision.md §8) — this is never a `GuardBlockedError`: the step proceeds,
 * just without an image. */
async function runStep5(payload: SanitizedContext, deps: GuardDeps): Promise<SanitizedContext> {
  if (!payload.image) return payload;
  if (!deps.imageRescan) return { ...payload, image: null };

  const regions = payload.redactions.map((r) => ({ entity: r.entity as string, boxes: r.boxes as Box[], placeholder: r.ref ?? null }));
  const imageBytes = base64ToArrayBuffer(payload.image.data);
  const outcome = await runImageRescan(imageBytes, regions, deps.imageRescan);

  if (outcome.verdict === 'dropped') return { ...payload, image: null };
  if (outcome.verdict === 'clean') return payload;
  return {
    ...payload,
    image: { ...payload.image, data: arrayBufferToBase64(outcome.imageBytes), sha256: await sha256Hex(outcome.imageBytes) },
  };
}

const NODE_ID_RE = /^n-[0-9a-z]+$/;
const TEXT_RUN_ID_RE = /^t-[0-9a-z]+$/;
const PLACEHOLDER_REF_RE = /^⟪[A-Z_]+#[0-9]+⟫$/;

/** Step 2: every id-like field must match its opaque pattern. Schema validation (step 1) already
 * enforces these patterns via regex `$ref`s, but this runs as an explicit second, independent
 * check — defence in depth, not a duplicate of trust in the same code path. */
function checkIdShapes(payload: SanitizedContext): boolean {
  for (const node of payload.nodes) {
    if (!NODE_ID_RE.test(node.id)) return false;
    if (node.value?.kind === 'placeholder' && !PLACEHOLDER_REF_RE.test(node.value.ref)) return false;
  }
  for (const run of payload.text) {
    if (!TEXT_RUN_ID_RE.test(run.id)) return false;
  }
  for (const r of payload.redactions) {
    if (r.ref != null && !PLACEHOLDER_REF_RE.test(r.ref)) return false;
  }
  return true;
}

function canonicalBytes(payload: SanitizedContext): string {
  const { image: _image, ...rest } = payload;
  return JSON.stringify(rest);
}

export async function guard(payload: SanitizedContext, policy: Policy, vault: Vault, deps: GuardDeps = {}): Promise<GuardedPayload> {
  const schemaResult = validators.sanitizedContext(payload);
  if (!schemaResult.valid) {
    throw new GuardBlockedError('SCHEMA');
  }

  if (!checkIdShapes(payload)) {
    throw new GuardBlockedError('ID_SHAPE');
  }

  const bytes = canonicalBytes(payload);

  const { image: _image, ...textPayload } = payload;
  const textLeaves = payloadTextLeaves(textPayload);
  const leak = vaultLeakSweep(vault, bytes, textLeaves);
  if (leak) {
    throw new GuardBlockedError('VAULT_LEAK');
  }

  const pattern = patternResweep(policy, bytes, textLeaves);
  if (pattern) {
    throw new GuardBlockedError('PATTERN', pattern.entity);
  }

  const afterStep5 = await runStep5(payload, deps);

  // Step 6, after step 5 per design.md's own ordering — checked against the same canonical text
  // bytes regardless of what step 5 did to the image (canaries are a text-only check here).
  if (deps.canaries && deps.canaries.length > 0) {
    const hit = checkForCanaries(bytes, deps.canaries);
    if (hit) throw new GuardBlockedError('CANARY');
  }

  return brand(afterStep5);
}

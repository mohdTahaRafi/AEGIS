// design.md §7.6 — the egress guard, the single choke point. Runs on the final serialized bytes,
// independently of whatever produced them (§7.2). T-3.22-3.25. Replaces the Phase-2 stub
// (T-3.26) — there is no path from here that returns an unbranded payload or a payload that
// skipped a step.

import type { SanitizedContext } from '@aegis/protocol';
import { validators } from '@aegis/protocol';
import type { Policy } from '@aegis/policy';
import { brand, type GuardedPayload } from '../../egress/brand';
import type { Vault } from '../vault';
import { patternResweep, vaultLeakSweep } from './sweeps';

export class GuardBlockedError extends Error {
  constructor(public readonly rule: 'SCHEMA' | 'ID_SHAPE' | 'VAULT_LEAK' | 'PATTERN', public readonly entity?: string) {
    super(`GUARD_BLOCK_${rule}`);
    this.name = 'GuardBlockedError';
  }
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

export function guard(payload: SanitizedContext, policy: Policy, vault: Vault): GuardedPayload {
  const schemaResult = validators.sanitizedContext(payload);
  if (!schemaResult.valid) {
    throw new GuardBlockedError('SCHEMA');
  }

  if (!checkIdShapes(payload)) {
    throw new GuardBlockedError('ID_SHAPE');
  }

  const bytes = canonicalBytes(payload);

  const leak = vaultLeakSweep(vault, bytes);
  if (leak) {
    throw new GuardBlockedError('VAULT_LEAK');
  }

  const pattern = patternResweep(policy, bytes);
  if (pattern) {
    throw new GuardBlockedError('PATTERN', pattern.entity);
  }

  // Step 5 (image re-scan) and step 6 (canary check) are no-ops this phase: there is no image
  // (L0 only — Phase 4), and canaries are Phase 5's T-5.8. Both are declared, not silently
  // skipped — see phase_3_privacy_core.md §16.

  return brand(payload);
}

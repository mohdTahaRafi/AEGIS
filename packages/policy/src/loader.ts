// T-3.6 — policy validates at load against policy.schema.json; an invalid policy fails loudly
// (throws), never silently defaults. design.md §7.2's "policy files are validated against a
// schema at load and their version is included in every payload."
//
// Uses a precompiled standalone validator (`scripts/generate-validator.ts` → `generated/
// validator.js`), NOT `new Ajv2020().compile()` at runtime. [Fixed, Phase 5] This module used to
// call `ajv.compile()` live at module load, which JIT-compiles via `new Function` — invisible in
// every unit test (jsdom/Node enforce no CSP at all) but fatal in the real built extension, whose
// manifest CSP (`script-src 'self' 'wasm-unsafe-eval'`) has no `'unsafe-eval'`. `defaultPolicy` is
// imported at module scope by `session.ts`, so this silently broke the entire side panel — caught
// only by a genuine end-to-end Playwright run against the real built extension, not by inspection
// or by any of this project's many existing tests. See docs/HISTORY.md's Phase 5 entry.

import type { AjvErrorObject as ErrorObject } from './generated/validator';
import { validatePolicy } from './generated/validator';
import defaultPolicyJson from '../policies/default.policy.json';
import type { Policy } from './types';

export class PolicyValidationError extends Error {
  constructor(public readonly errors: ErrorObject[]) {
    super(`Invalid policy: ${errors.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')}`);
    this.name = 'PolicyValidationError';
  }
}

/** Throws `PolicyValidationError` on anything that doesn't match `policy.schema.json` — this is
 * the only way an invalid policy is handled. There is no fallback-to-defaults branch. */
export function loadPolicy(raw: unknown): Policy {
  const valid = validatePolicy(raw);
  if (!valid) {
    throw new PolicyValidationError(validatePolicy.errors ?? []);
  }
  return raw as unknown as Policy;
}

/** The bundled default policy, already validated once at module load (a corrupted bundle should
 * fail the extension's own startup, not silently ship an unvalidated policy). */
export const defaultPolicy: Policy = loadPolicy(defaultPolicyJson);

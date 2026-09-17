// T-3.6 — policy validates at load against policy.schema.json; an invalid policy fails loudly
// (throws), never silently defaults. design.md §7.2's "policy files are validated against a
// schema at load and their version is included in every payload."

import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js';
import policySchema from '../policy.schema.json';
import defaultPolicyJson from '../policies/default.policy.json';
import type { Policy } from './types';

export class PolicyValidationError extends Error {
  constructor(public readonly errors: ErrorObject[]) {
    super(`Invalid policy: ${errors.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')}`);
    this.name = 'PolicyValidationError';
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(policySchema);

/** Throws `PolicyValidationError` on anything that doesn't match `policy.schema.json` — this is
 * the only way an invalid policy is handled. There is no fallback-to-defaults branch. */
export function loadPolicy(raw: unknown): Policy {
  const valid = validate(raw);
  if (!valid) {
    throw new PolicyValidationError(validate.errors ?? []);
  }
  return raw as unknown as Policy;
}

/** The bundled default policy, already validated once at module load (a corrupted bundle should
 * fail the extension's own startup, not silently ship an unvalidated policy). */
export const defaultPolicy: Policy = loadPolicy(defaultPolicyJson);

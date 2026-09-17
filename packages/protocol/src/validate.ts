import {
  validateActionPlan,
  validateErrorResponse,
  validateSanitizedContext,
  validateSessionCreate,
  validateSessionCreated,
} from './generated/validators.js';

export interface ValidationError {
  /** JSON Pointer-ish path, e.g. "/nodes/0/id" or "" for the root. */
  path: string;
  message: string;
}

export type ValidationResult<T> =
  | { valid: true; data: T }
  | { valid: false; errors: ValidationError[] };

// Ajv's own type for a compiled validator; the standalone-generated functions match this shape
// at runtime (errors array set on failure) without shipping the Ajv compiler itself.
interface AjvLikeValidator {
  (data: unknown): boolean;
  errors?: Array<{ instancePath: string; message?: string }> | null;
}

function run<T>(fn: AjvLikeValidator, data: unknown): ValidationResult<T> {
  const ok = fn(data);
  if (ok) return { valid: true, data: data as T };
  const errors: ValidationError[] = (fn.errors ?? []).map((e) => ({
    path: e.instancePath || '/',
    message: e.message ?? 'invalid',
  }));
  return { valid: false, errors };
}

import type { SanitizedContext } from './generated/sanitized-context.js';
import type { ActionPlan } from './generated/action-plan.js';
import type { ErrorResponse } from './generated/error-response.js';
import type { SessionCreate } from './generated/session-create.js';
import type { SessionCreated } from './generated/session-created.js';

export const validators = {
  sanitizedContext: (data: unknown): ValidationResult<SanitizedContext> =>
    run(validateSanitizedContext as AjvLikeValidator, data),
  actionPlan: (data: unknown): ValidationResult<ActionPlan> =>
    run(validateActionPlan as AjvLikeValidator, data),
  errorResponse: (data: unknown): ValidationResult<ErrorResponse> =>
    run(validateErrorResponse as AjvLikeValidator, data),
  sessionCreate: (data: unknown): ValidationResult<SessionCreate> =>
    run(validateSessionCreate as AjvLikeValidator, data),
  sessionCreated: (data: unknown): ValidationResult<SessionCreated> =>
    run(validateSessionCreated as AjvLikeValidator, data),
};

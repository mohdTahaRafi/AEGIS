import {
  validateActionPlan,
  validateErrorResponse,
  validateSanitizedContext,
  validateSessionCreate,
  validateSessionCreated,
} from './generated/validators.js';
import type { AjvValidateFunction } from './generated/validators.js';
import type { SanitizedContext } from './generated/sanitized-context.js';
import type { ActionPlan } from './generated/action-plan.js';
import type { ErrorResponse } from './generated/error-response.js';
import type { SessionCreate } from './generated/session-create.js';
import type { SessionCreated } from './generated/session-created.js';

export interface ValidationError {
  /** JSON Pointer-ish path, e.g. "/nodes/0/id" or "" for the root. */
  path: string;
  message: string;
}

export type ValidationResult<T> =
  | { valid: true; data: T }
  | { valid: false; errors: ValidationError[] };

function run<T>(fn: AjvValidateFunction, data: unknown): ValidationResult<T> {
  const ok = fn(data);
  if (ok) return { valid: true, data: data as T };
  const errors: ValidationError[] = (fn.errors ?? []).map((e) => ({
    path: e.instancePath || '/',
    message: e.message ?? 'invalid',
  }));
  return { valid: false, errors };
}

export const validators = {
  sanitizedContext: (data: unknown): ValidationResult<SanitizedContext> =>
    run(validateSanitizedContext, data),
  actionPlan: (data: unknown): ValidationResult<ActionPlan> =>
    run(validateActionPlan, data),
  errorResponse: (data: unknown): ValidationResult<ErrorResponse> =>
    run(validateErrorResponse, data),
  sessionCreate: (data: unknown): ValidationResult<SessionCreate> =>
    run(validateSessionCreate, data),
  sessionCreated: (data: unknown): ValidationResult<SessionCreated> =>
    run(validateSessionCreated, data),
};

// A failed step call, described only in a closed vocabulary (a code, and for MODEL_UNAVAILABLE the
// reason) plus a Retry-After. Never free text from the model or its API, so `detail` is safe to
// show in the panel and to log. `session.ts` classifies failures by `status`, `retryable` and
// `retryAfterS`, and reacts to a detail starting with `UNSANITIZED_CONTEXT`.
export class StepFailedError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly retryable = false,
    readonly retryAfterS?: number,
  ) {
    super(`STEP_FAILED: ${status}${detail ? ` ${detail}` : ''}`);
    this.name = 'StepFailedError';
  }
}

/** Reasons a model call can fail, all closed vocabulary: `upstream_429`, `upstream_5xx`, `unreachable`
 * and `bad_body` are transient (retryable); `upstream_auth` (the key was refused), `upstream_too_large`
 * and `upstream_4xx` are not — the same request fails the same way again. */
export function modelUnavailable(reason: string, opts: { retryAfterS?: number; retryable?: boolean; detail?: string } = {}): StepFailedError {
  const retryable = opts.retryable ?? true;
  const detail = `MODEL_UNAVAILABLE ${reason}${opts.detail ? ` (${opts.detail})` : ''}`;
  const retryAfter = opts.retryAfterS !== undefined && opts.retryAfterS > 0 ? Math.max(1, Math.round(opts.retryAfterS)) : undefined;
  return new StepFailedError(retryable ? 503 : 502, retryAfter ? `${detail} retry in ${retryAfter} s` : detail, retryable, retryAfter);
}

/** The API refused the request's size (input tokens over the per-minute limit): permanent for these
 * exact messages, but the engine may rebuild them smaller. */
export class ModelRequestTooLarge extends StepFailedError {
  constructor(
    readonly limit?: number,
    readonly requested?: number,
  ) {
    super(502, `MODEL_UNAVAILABLE upstream_too_large (${limit && requested ? `input ${requested} tokens > limit ${limit} per minute` : 'request too large'})`, false);
    this.name = 'ModelRequestTooLarge';
  }
}

export const modelTimeout = (): StepFailedError => new StepFailedError(504, 'MODEL_TIMEOUT', true);
/** `reason` is the validator's own message: schema paths, node ids and sealed refs, never page text
 * or anything the model wrote as prose. */
export const planInvalid = (reason?: string): StepFailedError => new StepFailedError(422, reason ? `PLAN_INVALID (${reason.slice(0, 160)})` : 'PLAN_INVALID', false);
export const unsanitizedContext = (entities: readonly string[]): StepFailedError => new StepFailedError(422, `UNSANITIZED_CONTEXT ${entities.join(',')}`.trim(), false);
export const sessionNotFound = (): StepFailedError => new StepFailedError(404, 'SESSION_NOT_FOUND', false);
export const stepOutOfOrder = (): StepFailedError => new StepFailedError(409, 'STEP_OUT_OF_ORDER', false);

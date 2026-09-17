// GENERATED FILE — do not hand-edit. Run `pnpm gen:protocol` to regenerate.
// Source: packages/protocol/schema/

/**
 * design.md §4.7.
 */
export interface ErrorResponse {
  error: {
    code:
      | 'SCHEMA_INVALID'
      | 'UNAUTHORIZED'
      | 'SESSION_NOT_FOUND'
      | 'STEP_OUT_OF_ORDER'
      | 'PAYLOAD_TOO_LARGE'
      | 'PLAN_INVALID'
      | 'RATE_LIMITED'
      | 'MODEL_UNAVAILABLE'
      | 'MODEL_TIMEOUT';
    message: string;
    request_id: string;
    retryable: boolean;
  };
}

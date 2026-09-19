// Closed-vocabulary reason codes shared across content/host. Never a free-text message built from
// page content — a human-readable string belongs in the panel's own copy, keyed off the code.

export type BudgetReasonCode =
  | 'STEPS_EXCEEDED'
  | 'SERVER_CALLS_EXCEEDED'
  | 'REPAIRS_EXCEEDED'
  | 'CAPTURES_EXCEEDED'
  | 'SETTLE_TIMEOUT'
  | 'SERVER_TIMEOUT'
  | 'WALL_CLOCK_EXCEEDED'
  | 'BUDGET_EXHAUSTED'
  /** design.md §5.5, T-6.7: sustained hostile-dynamic mode — the agent "stops with an explanation
   * if it cannot act safely," the same graceful-stop shape as every other budget exhaustion. */
  | 'HOSTILE_DYNAMIC'
  /** FR-8/NG-8, T-6.13: "when a CAPTCHA is detected, the agent shall stop and hand control to the
   * user" — design.md §16's own reason-code table lists `CAPTCHA_DETECTED` as content-origin,
   * "hand-off to user," the same graceful-stop shape every other row in this type already has. */
  | 'CAPTCHA_DETECTED';

export type HardDenialReasonCode = 'PROTECTED_FIELD_READ' | 'CAPTCHA_SOLVE' | 'EXTENSION_UI_TARGET';

/**
 * A hallucinated op is a schema failure (`SCHEMA_INVALID`), not its own code — design.md: "A
 * hallucinated action is a parse error, not a click." NFR-12 ("server output is never code") has
 * no code here either: it's enforced by never writing a code path that evals/builds a
 * regex/selector from plan text, not by a runtime check (see validator.ts's doc comment).
 */
export type ValidatorReasonCode = 'SCHEMA_INVALID' | 'LEASE_EXPIRED' | HardDenialReasonCode;

export class AegisError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'AegisError';
  }
}

// CLAUDE.md style rule: "Logs use a closed vocabulary (numbers, enums, versions). Never log page
// text, node names or values." This is the one logging entry point for content/host/perception —
// its type signature makes the rule mechanical rather than a review checklist item: `detail` is
// `number | boolean | undefined`, so a caller cannot accidentally pass a string of page content.

import type { PreflightFailureReason } from './messages';

export type LogCode =
  | 'port_connected'
  | 'port_disconnected'
  | 'port_message_malformed'
  | 'port_handler_failed'
  | 'port_sender_untrusted'
  | 'extract_started'
  | 'extract_completed'
  | 'observers_started'
  | 'observers_stopped'
  | 'permission_revoked'
  | 'permission_granted'
  | 'action_dispatched'
  | 'action_result'
  | 'preflight_failed'
  | 'settle_timeout'
  | 'controller_transition'
  | 'budget_exceeded'
  | 'guard_stub_invoked'
  | 'guard_stub_refused_origin'
  | 'egress_send';

export interface LogEvent {
  code: LogCode;
  detail?: number | boolean | string;
}

/** `detail` accepts a closed set of small strings (reason codes, enum values) — never free text. */
// Every PreflightFailureReason, as a Record so adding a reason without listing it here is a type
// error. (NODE_VOLATILE was missing: logging it threw inside the action handler, which then never
// answered the host, so a `type` into a live editor hung the task — found on Gmail, 2026-09-29.)
const PREFLIGHT_REASONS: Record<PreflightFailureReason, true> = {
  NODE_UNRESOLVED: true, FACET_ROLE: true, FACET_NAME: true, HIT_TEST_FAILED: true, DISABLED: true,
  CONTAINER_MISMATCH: true, LEASE_EXPIRED: true, NODE_VOLATILE: true, INTERNAL_ERROR: true,
};

const ALLOWED_STRING_DETAILS = new Set<string>([
  ...Object.keys(PREFLIGHT_REASONS),
  // controller states (design.md §10.1)
  'IDLE', 'PREPARING', 'OBSERVING', 'PERCEIVING', 'SANITIZING', 'GUARDING', 'BLOCK', 'SENDING',
  'AWAITING_SERVER', 'VALIDATING', 'RECONCILING', 'ACTING', 'SETTLING', 'DONE', 'ERROR', 'CANCELLED', 'STOPPED',
  // budget reason codes
  'STEPS_EXCEEDED', 'SERVER_CALLS_EXCEEDED', 'REPAIRS_EXCEEDED', 'CAPTURES_EXCEEDED', 'SETTLE_TIMEOUT', 'SERVER_TIMEOUT', 'WALL_CLOCK_EXCEEDED', 'BUDGET_EXHAUSTED',
]);

function assertClosedVocabulary(detail: LogEvent['detail']): void {
  if (typeof detail === 'string' && !ALLOWED_STRING_DETAILS.has(detail)) {
    throw new Error(`[aegis] logger.ts: "${detail}" is not in the closed vocabulary — add it to ALLOWED_STRING_DETAILS or log a number/boolean instead`);
  }
}

export function log(event: LogEvent): void {
  assertClosedVocabulary(event.detail);
  console.info(`[aegis] ${event.code}${event.detail !== undefined ? ` detail=${String(event.detail)}` : ''}`);
}

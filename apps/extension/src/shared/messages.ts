// design.md §5.1 / phase_2_spine.md §3.1, T-2.5 — the typed port contract between the content
// script and the host (side panel). This is an in-browser message channel, not the network
// contract in packages/protocol/schema/ (CLAUDE.md rule 6's "one contract" is about what crosses
// the network); it gets its own small, hand-written runtime validators rather than a JSON Schema,
// because it never leaves the device and the "reject unknown fields" strictness that matters for
// an untrusted server does not apply to a channel this extension owns both ends of.
//
// `src/shared` is importable from both `src/content` and `src/host` (they may not import each
// other — architecture.md §15.2/§15.3) so this file must not depend on either context's internals.

import type { EntityType } from '@aegis/recognizers';

export type Affordance = 'click' | 'type' | 'select' | 'toggle' | 'scroll';

/** design.md §6.1's Channel D signal (T-3.8), carried from content to host. */
export interface WireChannelDSignal {
  entity: EntityType;
  score: number;
  valueRead: boolean;
}

/** design.md §5.5/§3.2 — free text on the page, distinct from field values (T-3.10's NER input,
 * Channel T's prose scan). */
export interface WireTextRun {
  id: string;
  box: [number, number, number, number];
  text: string;
}

export interface WireScreenNodeState {
  focused: boolean;
  disabled: boolean;
  readonly: boolean;
  required: boolean;
  checked?: boolean;
  expanded?: boolean;
  selected?: boolean;
  hasValue: boolean;
  valueLen: number;
  occluded: boolean;
  volatile: boolean;
}

export interface WireScreenNodeField {
  inputType: string;
  autocomplete?: string;
  inputmode?: string;
  maskedCss: boolean;
  valueRead: boolean;
  value?: string;
}

/**
 * `RawScreenNode` minus `key` (phase_2_spine.md §3.2: the content-addressed key is a local
 * re-resolution handle and must never cross this port, exactly as it must never cross the
 * network — a structural path can itself carry PII).
 */
export interface WireScreenNode {
  id: string;
  frame: string;
  role: string;
  name: string;
  box: [number, number, number, number];
  z: number;
  state: WireScreenNodeState;
  affordances: Affordance[];
  field?: WireScreenNodeField;
  container: string;
  textRuns: string[];
  domSignal?: WireChannelDSignal;
}

export type PreflightFailureReason =
  | 'NODE_UNRESOLVED'
  | 'FACET_ROLE'
  | 'FACET_NAME'
  | 'HIT_TEST_FAILED'
  | 'DISABLED'
  | 'CONTAINER_MISMATCH'
  | 'LEASE_EXPIRED';

export interface WireActionExpect {
  role?: string;
  name?: string;
  boxTolerancePx?: number;
}

/** The subset of `Action` ops the content script can actually execute (design.md §5.9). */
export type WireAction =
  | { op: 'click'; node: string; expect?: WireActionExpect }
  | { op: 'type'; node: string; text: string; clearFirst?: boolean; expect?: WireActionExpect }
  | { op: 'select'; node: string; option: string; expect?: WireActionExpect }
  | { op: 'scroll'; direction: 'up' | 'down' | 'left' | 'right'; amount?: 'small' | 'page' | 'end'; node?: string }
  | { op: 'click_point'; x: number; y: number; label: string };

export interface DispatchActionMessage {
  type: 'dispatch-action';
  actionId: string;
  action: WireAction;
}

export type HostToContentMessage = { type: 'extract' } | DispatchActionMessage | { type: 'ping' };

export interface GraphMessage {
  type: 'graph';
  frame: string;
  nodes: WireScreenNode[];
  removed: string[];
  textRuns: WireTextRun[];
  privacyEpoch: number;
  reason: 'initial' | 'after_action' | 'requested' | 'reconcile';
}

export interface ActionResultMessage {
  type: 'action-result';
  actionId: string;
  ok: boolean;
  reason?: PreflightFailureReason;
}

export interface SettledMessage {
  type: 'settled';
  actionId: string;
}

export interface NavigatedMessage {
  type: 'navigated';
}

export type ContentToHostMessage =
  | { type: 'ready'; frame: string }
  | GraphMessage
  | ActionResultMessage
  | SettledMessage
  | NavigatedMessage
  | { type: 'pong' };

export const PORT_NAME = 'aegis-content-host';

/**
 * T-2.2 — a one-off broadcast from `entrypoints/background.ts` (via `runtime.sendMessage`, not
 * the content↔host port above) whenever the browser reports a host permission removed mid-task.
 * Background only forwards this; deciding whether it matters to the *current* task and stopping
 * it is host-side logic (src/host/platform/capabilities.ts), so background stays near-zero LOC.
 */
export interface PermissionRevokedMessage {
  type: 'permission-revoked';
  origin: string;
}

export function isPermissionRevokedMessage(value: unknown): value is PermissionRevokedMessage {
  return isRecord(value) && value.type === 'permission-revoked' && typeof value.origin === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const HOST_TO_CONTENT_TYPES = new Set(['extract', 'dispatch-action', 'ping']);
const CONTENT_TO_HOST_TYPES = new Set(['ready', 'graph', 'action-result', 'settled', 'navigated', 'pong']);

/**
 * Validated, not merely typed: a message arrives as `unknown` off a port, and a malformed one
 * must be dropped with a closed-vocabulary log rather than thrown into the page (T-2.5's AC).
 */
export function isHostToContentMessage(value: unknown): value is HostToContentMessage {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (!HOST_TO_CONTENT_TYPES.has(value.type)) return false;
  if (value.type === 'dispatch-action') {
    return typeof value.actionId === 'string' && isRecord(value.action) && typeof (value.action as { op?: unknown }).op === 'string';
  }
  return true;
}

export function isContentToHostMessage(value: unknown): value is ContentToHostMessage {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (!CONTENT_TO_HOST_TYPES.has(value.type)) return false;
  if (value.type === 'graph') {
    return (
      typeof value.frame === 'string' &&
      Array.isArray(value.nodes) &&
      Array.isArray(value.removed) &&
      Array.isArray(value.textRuns) &&
      typeof value.privacyEpoch === 'number'
    );
  }
  if (value.type === 'action-result') {
    return typeof value.actionId === 'string' && typeof value.ok === 'boolean';
  }
  if (value.type === 'settled') {
    return typeof value.actionId === 'string';
  }
  if (value.type === 'ready') {
    return typeof value.frame === 'string';
  }
  return true;
}

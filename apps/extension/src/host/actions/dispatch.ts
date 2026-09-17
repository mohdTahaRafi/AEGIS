// design.md §5.1 step 3 (op-specific policy) — routes a validated protocol `Action` to wherever it
// actually gets handled: the content script (for anything touching the live page) or the host
// itself (report/ask_user/done/stop/wait/request_observation, none of which need the page at
// all). In Phase 2 this is thin, per phase_2_spine.md §5.1: `type` carries literal text only (no
// vault to resolve a `ref` against — the validator's hard denial already refuses those before this
// ever runs), `click_point` requires the host to have shown the user the point first (design.md
// §5.9 — enforced by the caller, not here), and `request_observation` is scheduled but has no
// image path to serve yet (Phase 4's forward dependency).

import type { ActionPlan } from '@aegis/protocol';
import type { WireAction, WireActionExpect } from '../../shared/messages';

// `Action` itself isn't re-exported from the package root (only `ActionPlan` is) — derived here
// rather than reaching into the generated file's internal path.
export type Action = ActionPlan['actions'][number];

export type HostHandledOp =
  | { kind: 'host'; op: 'report'; title?: string; content: string }
  | { kind: 'host'; op: 'ask_user'; question: string }
  | { kind: 'host'; op: 'done'; summary?: string }
  | { kind: 'host'; op: 'stop'; reason: string }
  | { kind: 'host'; op: 'wait'; ms: number }
  | { kind: 'host'; op: 'request_observation'; level: 'L1' | 'L2' };

export type ContentDispatchable = { kind: 'content'; action: WireAction };

function mapExpect(expect: { role?: string; name?: string; box_tolerance_px?: number } | undefined): WireActionExpect | undefined {
  if (!expect) return undefined;
  return { role: expect.role, name: expect.name, boxTolerancePx: expect.box_tolerance_px };
}

/**
 * Throws if given a `type` action carrying `ref` — the validator's `PROTECTED_FIELD_READ` hard
 * denial must already have refused the whole plan before any action in it reaches here. A throw,
 * not a silent fallback, because reaching this branch means that invariant was violated upstream.
 */
export function classifyAction(action: Action): HostHandledOp | ContentDispatchable {
  switch (action.op) {
    case 'report':
      return { kind: 'host', op: 'report', title: action.title, content: action.content };
    case 'ask_user':
      return { kind: 'host', op: 'ask_user', question: action.question };
    case 'done':
      return { kind: 'host', op: 'done', summary: action.summary };
    case 'stop':
      return { kind: 'host', op: 'stop', reason: action.reason };
    case 'wait':
      return { kind: 'host', op: 'wait', ms: action.ms };
    case 'request_observation':
      return { kind: 'host', op: 'request_observation', level: action.level };
    case 'click':
      return { kind: 'content', action: { op: 'click', node: action.node, expect: mapExpect(action.expect) } };
    case 'type':
      if ('ref' in action) {
        throw new Error('PROTECTED_FIELD_READ: a ref-based type action reached classifyAction — the validator must reject this before dispatch');
      }
      return {
        kind: 'content',
        action: { op: 'type', node: action.node, text: action.text, clearFirst: action.clear_first, expect: mapExpect(action.expect) },
      };
    case 'select':
      return { kind: 'content', action: { op: 'select', node: action.node, option: action.option, expect: mapExpect(action.expect) } };
    case 'scroll':
      return { kind: 'content', action: { op: 'scroll', direction: action.direction, amount: action.amount, node: action.node } };
    case 'click_point':
      return { kind: 'content', action: { op: 'click_point', x: action.x, y: action.y, label: action.label } };
  }
}

// Everything one task run did, in the order it happened: the setup, then per step what ran on
// this device, what was sent, what the server model answered (including any text it wrote) and
// what was executed on the page, then the result. A pure fold over the session's own events
// (session.ts `SessionEvent`) plus the panel's setup/navigation notes; an event that carries no
// step id belongs to the step that is running when it arrives.

import type { SanitizedContext } from '@aegis/protocol';
import type { PerceptionStepStatus } from '../host/perception-client/run-step';
import type { ProtectedField, SessionEvent, StepRecord } from '../host/session';
import { applyActivityEvent, type ActivityEntry } from './ActivityLog';

export type RunLogEvent = SessionEvent | { type: 'note'; text: string };

/** Text the server model wrote itself: a report, a done summary, a stop explanation, a question. */
export interface ModelText {
  label: string;
  text: string;
}

export interface StepLog {
  stepId: string;
  perception?: PerceptionStepStatus;
  payload?: SanitizedContext;
  protectedFields: ProtectedField[];
  guardBlock?: { rule: string; entity?: string };
  /** Before the plan arrived: rate-limit waits and server errors, in order. */
  serverNotes: string[];
  /** The validated plan and each operation's execution status (ActivityLog's entries). */
  activity: ActivityEntry[];
  modelTexts: ModelText[];
  /** On the page while acting: confirmations asked, values not filled in, navigations. */
  pageNotes: string[];
  record?: StepRecord;
}

export interface RunLog {
  setup: string[];
  steps: StepLog[];
  result?: { kind: 'done' | 'stopped'; text: string };
}

export const EMPTY_RUN_LOG: RunLog = { setup: [], steps: [] };

const NEEDS_INPUT_TITLE = 'AEGIS needs your input';

function upsert(log: RunLog, stepId: string, change: (step: StepLog) => StepLog): RunLog {
  const at = log.steps.findIndex((s) => s.stepId === stepId);
  if (at === -1) {
    const fresh: StepLog = { stepId, protectedFields: [], serverNotes: [], activity: [], modelTexts: [], pageNotes: [] };
    return { ...log, steps: [...log.steps, change(fresh)] };
  }
  return { ...log, steps: log.steps.map((s, i) => (i === at ? change(s) : s)) };
}

/** The running step, or the setup list when no step has started yet. */
function current(log: RunLog, change: (step: StepLog) => StepLog, setupText?: string): RunLog {
  const last = log.steps.at(-1);
  if (last) return upsert(log, last.stepId, change);
  return setupText ? { ...log, setup: [...log.setup, setupText] } : log;
}

export function applyRunLogEvent(log: RunLog, event: RunLogEvent): RunLog {
  switch (event.type) {
    case 'note':
      return log.steps.length === 0 ? { ...log, setup: [...log.setup, event.text] } : current(log, (s) => ({ ...s, pageNotes: [...s.pageNotes, event.text] }));
    case 'perception':
      return upsert(log, event.stepId, (s) => ({ ...s, perception: event.status }));
    case 'sanitized_preview':
      return upsert(log, event.payload.step_id, (s) => ({ ...s, payload: event.payload, protectedFields: event.protectedFields ?? [] }));
    case 'guard_blocked':
      return current(log, (s) => ({ ...s, guardBlock: { rule: event.rule, entity: event.entity } }), `guard blocked: ${event.rule}`);
    case 'waiting':
      return current(log, (s) => ({ ...s, serverNotes: [...s.serverNotes, `server busy (${event.reason || 'retryable'}): re-sent this step after ${event.seconds} s`] }));
    case 'recovering': {
      const text = `recovered (${event.what}): ${event.detail}`;
      return event.what === 'server'
        ? current(log, (s) => ({ ...s, serverNotes: [...s.serverNotes, text] }), text)
        : current(log, (s) => ({ ...s, pageNotes: [...s.pageNotes, text] }), text);
    }
    case 'waiting_user': {
      const text = `waiting for you (${event.reason})${event.detail ? `: ${event.detail}` : ''}`;
      return current(log, (s) => ({ ...s, pageNotes: [...s.pageNotes, text] }), text);
    }
    case 'page_ready': {
      const text = event.timedOut
        ? `page still loading after ${Math.round(event.waitedMs / 100) / 10} s (${event.pendingImages} picture(s) pending): observed anyway`
        : `waited ${Math.round(event.waitedMs / 100) / 10} s for the page to finish loading (pictures, content)`;
      return current(log, (s) => ({ ...s, pageNotes: [...s.pageNotes, text] }), text);
    }
    case 'plan':
    case 'plan_rejected':
    case 'action_status':
      return upsert(log, event.stepId, (s) => ({ ...s, activity: applyActivityEvent(s.activity, event) }));
    case 'rehydration_rejected':
      return current(log, (s) => ({ ...s, pageNotes: [...s.pageNotes, `a sealed value was not filled in: ${event.code}`] }));
    case 'confirmation_required':
      return current(log, (s) => ({ ...s, pageNotes: [...s.pageNotes, `asked you to confirm (${event.risk} risk): ${event.description}`] }));
    case 'report':
      if (event.title === NEEDS_INPUT_TITLE) return log; // the ask_user event already recorded it
      return current(log, (s) => ({ ...s, modelTexts: [...s.modelTexts, { label: event.title ? `Report: ${event.title}` : 'Report', text: event.content }] }));
    case 'ask_user':
      return current(log, (s) => ({ ...s, modelTexts: [...s.modelTexts, { label: 'Question for you', text: event.question }] }));
    case 'done': {
      const withText = event.summary ? current(log, (s) => ({ ...s, modelTexts: [...s.modelTexts, { label: 'Done summary', text: event.summary! }] })) : log;
      return { ...withText, result: { kind: 'done', text: event.summary ?? 'Task complete' } };
    }
    case 'stopped': {
      const text = event.detail ? `${event.reason}: ${event.detail}` : event.reason;
      let next = log;
      if (event.reason === 'MODEL_STOPPED') {
        next = current(next, (s) => ({ ...s, modelTexts: [...s.modelTexts, { label: 'Stopped by the model', text: event.detail ?? '' }] }));
      } else if (event.reason === 'SERVER_ERROR') {
        next = current(next, (s) => ({ ...s, serverNotes: [...s.serverNotes, `no plan: ${event.detail ?? 'server error'}`] }));
      }
      return { ...next, result: { kind: 'stopped', text } };
    }
    case 'step':
      return upsert(log, event.step.stepId, (s) => ({ ...s, record: event.step }));
    default:
      return log;
  }
}

// What the server model told the extension to do, and what the extension actually did with it:
// one block per step, one line per operation, each moving validated → executed / failed / declined
// / skipped. Descriptions use the sanitized names that were sent (session.ts `describeAction`).

import type { ActionStatus, SessionEvent } from '../host/session';

export type ActivityEntry =
  | { kind: 'note'; text: string }
  | { kind: 'plan'; stepId: string; actions: { text: string; status: 'validated' | ActionStatus; reason?: string }[] }
  | { kind: 'rejected'; stepId: string; reason: string };

/** Folds one session event into the log; events that don't concern it return `entries` as is. */
export function applyActivityEvent(entries: ActivityEntry[], event: SessionEvent): ActivityEntry[] {
  if (event.type === 'plan') {
    return [...entries, { kind: 'plan', stepId: event.stepId, actions: event.actions.map((text) => ({ text, status: 'validated' })) }];
  }
  if (event.type === 'plan_rejected') return [...entries, { kind: 'rejected', stepId: event.stepId, reason: event.reason }];
  if (event.type === 'action_status') {
    return entries.map((e) =>
      e.kind === 'plan' && e.stepId === event.stepId
        ? { ...e, actions: e.actions.map((a, i) => (i === event.index ? { ...a, status: event.status, reason: event.reason } : a)) }
        : e,
    );
  }
  if (event.type === 'waiting') return [...entries, { kind: 'note', text: `model busy (${event.reason || 'retryable'}): re-sending this step in ${event.seconds} s` }];
  if (event.type === 'rehydration_rejected') return [...entries, { kind: 'note', text: `value not filled in: ${event.code}` }];
  return entries;
}

export const STATUS_STYLE: Record<'validated' | ActionStatus, { mark: string; color: string; label: string }> = {
  validated: { mark: '…', color: '#555', label: 'validated, running' },
  executed: { mark: '✓', color: '#070', label: 'executed' },
  failed: { mark: '✗', color: '#b00', label: 'failed' },
  declined: { mark: '✗', color: '#b00', label: 'declined' },
  skipped: { mark: '–', color: '#777', label: 'not run' },
};

export function ActivityLog({ entries }: { entries: ActivityEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div data-testid="activity" style={{ margin: '8px 0', fontSize: 12 }}>
      <strong>Activity</strong> (VLM plan → validated by gateway + extension → executed on this page)
      {entries.map((entry, i) =>
        entry.kind === 'note' ? (
          <div key={i} style={{ color: '#555', margin: '4px 0' }}>
            {entry.text}
          </div>
        ) : entry.kind === 'rejected' ? (
          <div key={i} style={{ color: '#b00', margin: '4px 0' }}>
            {entry.stepId}: plan rejected by the extension's validator ({entry.reason}); nothing executed
          </div>
        ) : (
          <div key={i} style={{ margin: '4px 0' }}>
            <div style={{ color: '#555' }}>
              {entry.stepId}: {entry.actions.length} operation(s) from the VLM
            </div>
            <ol style={{ margin: '2px 0', paddingLeft: 18 }}>
              {entry.actions.map((a, j) => {
                const st = STATUS_STYLE[a.status];
                return (
                  <li key={j} data-status={a.status}>
                    {a.text}{' '}
                    <span style={{ color: st.color }}>
                      {st.mark} {st.label}
                      {a.reason ? `: ${a.reason}` : ''}
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
        ),
      )}
    </div>
  );
}

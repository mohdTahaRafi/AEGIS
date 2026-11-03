// design.md §13.2 — Phase 3 adds the two states Phase 2 deferred: "Awaiting confirmation" (a
// confirmation card, T-3.31) and "Blocked by guard" (a guard-block card, T-3.34). The Phase-2
// guard-stub banner is gone (T-3.26) — there is no more unredacted-by-design state to warn about.

export type PanelState = 'no-permission' | 'loading' | 'idle' | 'running' | 'awaiting-confirmation' | 'awaiting-grant' | 'awaiting-user' | 'blocked' | 'error' | 'done' | 'interrupted';

const STATE_LABELS: Record<PanelState, string> = {
  'no-permission': 'No permission for this site',
  loading: 'Loading',
  idle: 'Idle',
  running: 'Running',
  'awaiting-confirmation': 'Awaiting confirmation',
  'awaiting-grant': 'Waiting for screenshot access',
  'awaiting-user': 'Waiting for your answer',
  blocked: 'Blocked by guard',
  error: 'Error',
  done: 'Done',
  // The panel was closed mid-task, which ended it; reopened, it can be resumed (host/saved-task.ts).
  interrupted: 'Interrupted',
};

export function panelStateLabel(state: PanelState): string {
  return STATE_LABELS[state];
}

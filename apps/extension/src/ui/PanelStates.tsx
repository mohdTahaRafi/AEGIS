// design.md §13.2 — Phase 3 adds the two states Phase 2 deferred: "Awaiting confirmation" (a
// confirmation card, T-3.31) and "Blocked by guard" (a guard-block card, T-3.34). The Phase-2
// guard-stub banner is gone (T-3.26) — there is no more unredacted-by-design state to warn about.

export type PanelState = 'no-permission' | 'loading' | 'idle' | 'running' | 'awaiting-confirmation' | 'awaiting-grant' | 'blocked' | 'error' | 'done';

const STATE_LABELS: Record<PanelState, string> = {
  'no-permission': 'No permission for this site',
  loading: 'Loading',
  idle: 'Idle',
  running: 'Running',
  'awaiting-confirmation': 'Awaiting confirmation',
  'awaiting-grant': 'Waiting for screenshot access',
  blocked: 'Blocked by guard',
  error: 'Error',
  done: 'Done',
};

export function panelStateLabel(state: PanelState): string {
  return STATE_LABELS[state];
}

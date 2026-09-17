// design.md §13.2 (T-2.30) — phase_2_spine.md §7 scopes Phase 2 to exactly six of the design
// doc's eight listed states: "Awaiting confirmation" (a confirmation card) and "Blocked by guard"
// (a guard-block card) are explicitly deferred to Phase 3 alongside the payload viewer. Risk
// classification itself exists now (src/host/actions/risk.ts) — only its confirmation-card UI is
// deferred, per src/host/session.ts's `confirm` default (auto-approve until that UI exists).

export type PanelState = 'no-permission' | 'loading' | 'idle' | 'running' | 'error' | 'done';

const STATE_LABELS: Record<PanelState, string> = {
  'no-permission': 'No permission for this site',
  loading: 'Loading',
  idle: 'Idle',
  running: 'Running',
  error: 'Error',
  done: 'Done',
};

/** The Phase-2 guard stub's mandated persistent banner (phase_2_spine.md §8) — shown regardless
 * of panel state, because the exposure it warns about exists in every state that can send a
 * payload. */
export function GuardStubBanner() {
  return (
    <div
      role="alert"
      style={{ background: '#b00020', color: 'white', padding: '6px 10px', fontWeight: 600, fontSize: 12, textAlign: 'center' }}
    >
      PHASE 2 BUILD — NO REDACTION
    </div>
  );
}

export function panelStateLabel(state: PanelState): string {
  return STATE_LABELS[state];
}

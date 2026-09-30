// Shown while a step is paused because Chrome refused the screenshot for lack of the activeTab
// grant (host/capture/grant-gate.ts). Redesigned: clean, compact security alert card.

import type { GrantExplanation } from '../shared/invocation';
import { C, R, S, T } from './design';

export interface GrantRequestProps {
  explanation: GrantExplanation;
  onAllowAllSites: () => void;
  onStop: () => void;
}

function why(explanation: GrantExplanation): string {
  switch (explanation.kind) {
    case 'lost-on-navigation':
      return `AEGIS was invoked on ${explanation.grantedOrigin}, but this tab has since moved to ${explanation.currentOrigin}. Chrome withdraws screenshot access whenever a tab moves to a different site.`;
    case 'invoked':
      return `AEGIS was invoked on this tab, but Chrome still refused the screenshot (for example after the extension was reloaded).`;
    case 'never-invoked':
      return 'AEGIS has not been invoked on this tab, and Chrome only allows screenshots of a tab after you click the AEGIS toolbar icon on it.';
  }
}

export function GrantRequest({ explanation, onAllowAllSites, onStop }: GrantRequestProps) {
  return (
    <div
      role="alertdialog"
      data-testid="grant-request"
      style={{
        border: `1px solid ${C.infoBorder}`,
        borderLeft: `3px solid ${C.accent}`,
        borderRadius: R.md,
        padding: '10px 12px',
        margin: '8px 0',
        background: C.infoBg,
      }}
    >
      <div style={{ fontSize: T.sm, fontWeight: 600, color: C.strong, marginBottom: 4 }}>
        Screenshot access needed
      </div>
      <p style={{ margin: '0 0 6px', fontSize: T.xs, color: C.body, lineHeight: 1.4 }}>
        {why(explanation)}
      </p>
      <p style={{ margin: '0 0 10px', fontSize: T.xs, color: C.secondary, lineHeight: 1.4 }}>
        With the task's tab in front, click the <strong>AEGIS icon in Chrome's toolbar</strong>, or allow AEGIS on all sites below. The task continues
        automatically. Nothing has been sent for this step yet.
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          onClick={onAllowAllSites}
          style={{
            ...S.btnPrimary,
            fontSize: T.sm,
            padding: '5px 12px',
          }}
        >
          Allow AEGIS on all sites
        </button>
        <button
          onClick={onStop}
          style={{
            ...S.btnSecondary,
            fontSize: T.sm,
            padding: '5px 12px',
          }}
        >
          Stop
        </button>
      </div>
    </div>
  );
}

// Shown while a step is paused because Chrome refused the screenshot for lack of the activeTab
// grant (host/capture/grant-gate.ts). Nothing has been sent for this step yet. The card only ever
// resolves by the user's own action: invoking AEGIS from the toolbar (detected by the background,
// never by this card), allowing AEGIS on all sites from the card (a host permission Chrome grants on
// this click, which also covers screenshots), or stopping. Every step carries a screenshot, so
// there is no way to continue without one.

import type { GrantExplanation } from '../shared/invocation';

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
    <div role="alertdialog" data-testid="grant-request" style={{ border: '2px solid #2563eb', borderRadius: 6, padding: 10, margin: '8px 0', background: '#eff6ff' }}>
      <p style={{ margin: '0 0 6px', fontWeight: 600 }}>Screenshot access needed</p>
      <p style={{ margin: '0 0 6px' }}>{why(explanation)}</p>
      <p style={{ margin: '0 0 8px' }}>
        With the task's tab in front, click the <strong>AEGIS icon in Chrome's toolbar</strong>, or allow AEGIS on all sites below. The task continues
        automatically. Nothing has been sent for this step yet.
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onAllowAllSites}>Allow AEGIS on all sites</button>
        <button onClick={onStop}>Stop</button>
      </div>
    </div>
  );
}

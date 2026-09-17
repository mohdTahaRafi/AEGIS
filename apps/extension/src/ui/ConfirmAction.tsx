// design.md §9.4 (T-3.31) — the confirmation card. 60s timeout → deny; no "always allow" in the
// first build. The on-page outline (closed shadow root, injected content-side) is a separate
// concern from this card — this component only renders the panel-side half.

import { useEffect, useState } from 'preact/hooks';

const TIMEOUT_MS = 60_000;

export interface ConfirmActionProps {
  description: string;
  risk: 'low' | 'medium' | 'high';
  onDecide: (allowed: boolean) => void;
}

export function ConfirmAction({ description, risk, onDecide }: ConfirmActionProps) {
  const [secondsLeft, setSecondsLeft] = useState(TIMEOUT_MS / 1000);

  useEffect(() => {
    const start = Date.now();
    const interval = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((TIMEOUT_MS - (Date.now() - start)) / 1000));
      setSecondsLeft(remaining);
      if (remaining === 0) {
        clearInterval(interval);
        onDecide(false);
      }
    }, 250);
    return () => clearInterval(interval);
  }, [onDecide]);

  return (
    <div role="alertdialog" style={{ border: '2px solid #d97706', borderRadius: 6, padding: 10, margin: '8px 0', background: '#fffbeb' }}>
      <p style={{ margin: '0 0 6px', fontWeight: 600 }}>Confirmation needed ({risk} risk)</p>
      <p style={{ margin: '0 0 8px' }}>{description}</p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => onDecide(true)}>Allow once</button>
        <button onClick={() => onDecide(false)}>Deny</button>
        <span style={{ marginLeft: 'auto', color: '#666', fontSize: 11 }}>{secondsLeft}s</span>
      </div>
    </div>
  );
}

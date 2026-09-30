// design.md §9.4 (T-3.31) — the confirmation card. 60s timeout → deny.
// Redesigned: minimal, clean card with amber security accent and crisp countdown timer.
import { useEffect, useState } from 'preact/hooks';
import { C, R, S, T } from './design';

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

  const riskColor = risk === 'high' ? C.error : risk === 'medium' ? C.warn : C.info;

  return (
    <div
      role="alertdialog"
      style={{
        border: `1px solid ${C.warnBorder}`,
        borderLeft: `3px solid ${riskColor}`,
        borderRadius: R.md,
        padding: '10px 12px',
        margin: '8px 0',
        background: C.warnBg,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: T.sm, fontWeight: 600, color: C.strong }}>
          Confirmation needed ({risk} risk)
        </span>
        <span style={{ fontSize: T.xs, color: C.secondary, fontFamily: 'monospace' }}>
          {secondsLeft}s
        </span>
      </div>
      <p style={{ margin: '0 0 10px', fontSize: T.sm, color: C.body, lineHeight: 1.4 }}>{description}</p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          onClick={() => onDecide(true)}
          style={{
            ...S.btnPrimary,
            background: riskColor,
            padding: '5px 12px',
            fontSize: T.sm,
          }}
        >
          Allow once
        </button>
        <button
          onClick={() => onDecide(false)}
          style={{
            ...S.btnSecondary,
            padding: '5px 12px',
            fontSize: T.sm,
          }}
        >
          Deny
        </button>
      </div>
    </div>
  );
}

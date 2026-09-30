// design.md §7.6/§7.4 (T-3.34) — shown when the guard blocks a step.
// Redesigned: clean, restrained security block card with clear hierarchy.
import { C, R, S, T } from './design';

export interface GuardBlockCardProps {
  rule: string;
  entity?: string;
  count: number;
  onRetry: () => void;
  onStop: () => void;
}

export function GuardBlockCard({ rule, entity, count, onRetry, onStop }: GuardBlockCardProps) {
  return (
    <div
      role="alert"
      style={{
        border: `1px solid ${C.errorBorder}`,
        borderLeft: `3px solid ${C.error}`,
        borderRadius: R.md,
        padding: '10px 12px',
        margin: '8px 0',
        background: C.errorBg,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span style={{ fontSize: T.sm, fontWeight: 600, color: C.error }}>
          Blocked — {rule}
          {entity ? `, entity ${entity}` : ''}
          {count > 1 ? `, count ${count}` : ''}
        </span>
      </div>
      <p style={{ margin: '0 0 10px', fontSize: T.xs, color: C.secondary }}>
        Nothing was sent. The step stopped.
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          onClick={onRetry}
          style={{
            ...S.btnSecondary,
            padding: '5px 12px',
            fontSize: T.sm,
          }}
        >
          Retry
        </button>
        <button
          onClick={onStop}
          style={{
            ...S.btnDanger,
            padding: '5px 12px',
            fontSize: T.sm,
          }}
        >
          Stop
        </button>
      </div>
    </div>
  );
}

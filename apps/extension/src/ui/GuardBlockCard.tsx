// design.md §7.6/§7.4 (T-3.34) — shown when the guard blocks a step. Rule, entity and count are
// exactly what the ledger recorded (design.md's "counts, never values").

export interface GuardBlockCardProps {
  rule: string;
  entity?: string;
  count: number;
  onRetry: () => void;
  onStop: () => void;
}

export function GuardBlockCard({ rule, entity, count, onRetry, onStop }: GuardBlockCardProps) {
  return (
    <div role="alert" style={{ border: '2px solid #b00020', borderRadius: 6, padding: 10, margin: '8px 0', background: '#fef2f2' }}>
      <p style={{ margin: '0 0 6px', fontWeight: 600, color: '#b00020' }}>
        Blocked — {rule}
        {entity ? `, entity ${entity}` : ''}
        {count > 1 ? `, count ${count}` : ''}
      </p>
      <p style={{ margin: '0 0 8px', fontSize: 12, color: '#555' }}>Nothing was sent. The step stopped.</p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onRetry}>Retry</button>
        <button onClick={onStop}>Stop</button>
      </div>
    </div>
  );
}

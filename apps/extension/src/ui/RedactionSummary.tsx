// design.md §12.1/§13.1 (T-3.33) — redaction counts by entity and channel, plus the coverage
// triple, for the step whose payload is shown.

import type { SanitizedContext } from '@aegis/protocol';

export interface RedactionSummaryProps {
  redactions: SanitizedContext['redactions'];
  coverage: SanitizedContext['coverage'];
}

function countByEntity(redactions: SanitizedContext['redactions']): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of redactions) counts[r.entity] = (counts[r.entity] ?? 0) + 1;
  return counts;
}

export function RedactionSummary({ redactions, coverage }: RedactionSummaryProps) {
  const byEntity = countByEntity(redactions);
  const entries = Object.entries(byEntity);

  return (
    <div style={{ fontSize: 12, margin: '8px 0' }}>
      <p style={{ margin: '0 0 4px', fontWeight: 600 }}>
        Redactions: {entries.length === 0 ? '0' : entries.map(([e, n]) => `${e} ${n}`).join(' · ')}
      </p>
      <p style={{ margin: 0, color: '#666' }}>
        Coverage — cleared {Math.round(coverage.cleared * 100)}% · redacted {Math.round(coverage.redacted * 100)}% · unanalysed{' '}
        {Math.round(coverage.unanalysed * 100)}%
      </p>
    </div>
  );
}

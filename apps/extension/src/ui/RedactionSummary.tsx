// design.md §12.1/§13.1 (T-3.33) — redaction counts by entity and channel, plus the coverage
// triple, for the step whose payload is shown.

import type { SanitizedContext } from '@aegis/protocol';
import type { ProtectedField } from '../host/session';

export interface RedactionSummaryProps {
  redactions: SanitizedContext['redactions'];
  coverage: SanitizedContext['coverage'];
  protectedFields?: ProtectedField[];
}

export const SENT_AS: Record<ProtectedField['sent'], string> = {
  empty: 'empty, masked in image',
  placeholder: 'sent as placeholder',
  presence: 'value never read',
  text: 'SENT AS TEXT, masked in image',
};

function countByEntity(redactions: SanitizedContext['redactions']): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of redactions) counts[r.entity] = (counts[r.entity] ?? 0) + 1;
  return counts;
}

export function RedactionSummary({ redactions, coverage, protectedFields = [] }: RedactionSummaryProps) {
  const byEntity = countByEntity(redactions);
  const entries = Object.entries(byEntity);

  return (
    <div style={{ fontSize: 12, margin: '8px 0' }}>
      <p style={{ margin: '0 0 4px', fontWeight: 600 }}>
        Redactions: {entries.length === 0 ? '0' : entries.map(([e, n]) => `${e} ${n}`).join(' · ')}
      </p>
      {protectedFields.length > 0 && (
        <p data-testid="protected-fields" style={{ margin: '0 0 4px' }}>
          Protected fields (by label, before sending):{' '}
          {protectedFields.map((f, i) => (
            <span key={i} style={{ color: f.sent === 'text' ? '#b00' : undefined }}>
              {i > 0 && ' · '}
              {f.entity} "{f.label.slice(0, 30)}" ({f.ref ?? SENT_AS[f.sent]})
            </span>
          ))}
        </p>
      )}
      <p style={{ margin: 0, color: '#666' }}>
        Coverage — cleared {Math.round(coverage.cleared * 100)}% · redacted {Math.round(coverage.redacted * 100)}% · unanalysed{' '}
        {Math.round(coverage.unanalysed * 100)}%
      </p>
    </div>
  );
}

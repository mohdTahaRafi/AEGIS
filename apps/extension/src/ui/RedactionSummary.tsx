// design.md §12.1/§13.1 (T-3.33) — redaction counts by entity and channel, plus the coverage
// triple, for the step whose payload is shown.
// Redesigned: clean card layout with entity badges, visual coverage bar, and protected fields.

import type { SanitizedContext } from '@aegis/protocol';
import type { ProtectedField } from '../host/session';
import { C, R, T } from './design';

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

  const clearedPct = Math.round(coverage.cleared * 100);
  const redactedPct = Math.round(coverage.redacted * 100);
  const unanalysedPct = Math.round(coverage.unanalysed * 100);

  return (
    <div style={{ fontSize: T.sm, margin: '6px 0' }}>
      {/* Redactions list */}
      <div style={{ margin: '0 0 6px', fontWeight: 600, color: C.strong, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
        <span>Redactions: {entries.length === 0 ? '0' : entries.map(([e, n]) => `${e} ${n}`).join(' · ')}</span>
      </div>

      {/* Protected fields */}
      {protectedFields.length > 0 && (
        <div data-testid="protected-fields" style={{ margin: '0 0 6px', fontSize: T.xs, color: C.secondary, lineHeight: 1.4 }}>
          <span style={{ fontWeight: 500, color: C.body }}>Protected fields (by label, before sending): </span>
          {protectedFields.map((f, i) => (
            <span key={i} style={{ color: f.sent === 'text' ? C.error : undefined }}>
              {i > 0 && ' · '}
              {f.entity} "{f.label.slice(0, 30)}" ({f.ref ?? SENT_AS[f.sent]})
            </span>
          ))}
        </div>
      )}

      {/* Visual coverage bar */}
      <div
        style={{
          display: 'flex',
          height: 5,
          borderRadius: R.sm,
          overflow: 'hidden',
          background: C.border,
          margin: '6px 0 4px',
        }}
        aria-hidden="true"
      >
        <div style={{ width: `${clearedPct}%`, background: C.ok }} title={`Cleared ${clearedPct}%`} />
        <div style={{ width: `${redactedPct}%`, background: C.warn }} title={`Redacted ${redactedPct}%`} />
        <div style={{ width: `${unanalysedPct}%`, background: C.muted }} title={`Unanalysed ${unanalysedPct}%`} />
      </div>

      {/* Coverage text */}
      <div style={{ margin: 0, color: C.secondary, fontSize: T.xs }}>
        Coverage — cleared {clearedPct}% · redacted {redactedPct}% · unanalysed {unanalysedPct}%
      </div>
    </div>
  );
}

// design.md §12.1/§13.1 (T-3.33) — redaction counts by entity, the coverage triple and the
// protected fields, for the step whose payload is shown.

import type { SanitizedContext } from '@aegis/protocol';
import type { ProtectedField } from '../host/session';
import { C, R, T, entityLabel } from './design';

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

export function countByEntity(redactions: SanitizedContext['redactions']): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of redactions) counts[r.entity] = (counts[r.entity] ?? 0) + 1;
  return counts;
}

function Legend({ color, label, pct }: { color: string; label: string; pct: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
      {label} <span style={{ color: C.body, fontWeight: 500 }}>{pct}%</span>
    </span>
  );
}

export function RedactionSummary({ redactions, coverage, protectedFields = [] }: RedactionSummaryProps) {
  const entries = Object.entries(countByEntity(redactions));

  const clearedPct = Math.round(coverage.cleared * 100);
  const redactedPct = Math.round(coverage.redacted * 100);
  const unanalysedPct = Math.round(coverage.unanalysed * 100);

  return (
    <div style={{ fontSize: T.sm }}>
      {entries.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
          {entries.map(([e, n]) => (
            <span
              key={e}
              title={e}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '3px 4px 3px 9px',
                border: `1px solid ${C.border}`,
                borderRadius: 100,
                fontSize: T.xs,
                color: C.body,
                background: C.bg,
              }}
            >
              <span>{entityLabel(e)}</span>{' '}
              <span style={{ minWidth: 18, textAlign: 'center', padding: '0 5px', borderRadius: 100, background: C.strong, color: C.white, fontWeight: 600, fontSize: 10.5 }}>{n}</span>
            </span>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', height: 6, borderRadius: R.sm, overflow: 'hidden', background: C.border }} aria-hidden="true">
        <div style={{ width: `${clearedPct}%`, background: C.ok }} title={`Cleared ${clearedPct}%`} />
        <div style={{ width: `${redactedPct}%`, background: C.warn }} title={`Redacted ${redactedPct}%`} />
        <div style={{ width: `${unanalysedPct}%`, background: C.muted }} title={`Unanalysed ${unanalysedPct}%`} />
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 12, rowGap: 2, marginTop: 6, fontSize: T.xs, color: C.secondary }}>
        <span style={{ color: C.secondary }}>Screenshot:</span>
        <Legend color={C.ok} label="checked, safe" pct={clearedPct} />
        <Legend color={C.warn} label="hidden" pct={redactedPct} />
        <Legend color={C.muted} label="greyed out" pct={unanalysedPct} />
      </div>

      {protectedFields.length > 0 && (
        <div data-testid="protected-fields" style={{ marginTop: 10 }}>
          <div style={{ fontSize: T.xs, color: C.secondary, marginBottom: 4 }}>Protected form fields (recognised by their label):</div>
          {protectedFields.map((f, i) => (
            <div
              key={i}
              style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: T.xs, padding: '3px 0', borderTop: i > 0 ? `1px solid ${C.border}` : 'none' }}
            >
              <span style={{ color: C.strong, fontWeight: 500, flexShrink: 0 }}>{entityLabel(f.entity)}</span>
              <span style={{ color: C.secondary, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>"{f.label.slice(0, 30)}"</span>
              <span style={{ color: f.sent === 'text' ? C.error : C.secondary, fontWeight: f.sent === 'text' ? 600 : 400, flexShrink: 0 }}>{f.ref ?? SENT_AS[f.sent]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

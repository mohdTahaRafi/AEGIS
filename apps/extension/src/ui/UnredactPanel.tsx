// design.md §7.1 step 9 / FR-36 (T-6.12) — user-un-redact action. Each sealed item can be shown to
// the model for the rest of this session, and only with a reason.

import { useState } from 'preact/hooks';
import type { SanitizedContext } from '@aegis/protocol';
import { IconCheck, IconChevron } from './icons';
import { C, R, S, T, entityLabel } from './design';

export interface UnredactPanelProps {
  redactions: SanitizedContext['redactions'];
  onUnredact(ref: string, reason: string): void;
}

const REF_RE = /^⟪[A-Z_]+#\d+⟫$/;

function distinctResolvableRefs(redactions: SanitizedContext['redactions']): { ref: string; entity: string }[] {
  const seen = new Map<string, string>();
  for (const r of redactions) {
    if (r.ref && REF_RE.test(r.ref) && !seen.has(r.ref)) seen.set(r.ref, r.entity);
  }
  return [...seen.entries()].map(([ref, entity]) => ({ ref, entity }));
}

export function UnredactPanel({ redactions, onUnredact }: UnredactPanelProps) {
  const refs = distinctResolvableRefs(redactions);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [done, setDone] = useState<Set<string>>(new Set());

  if (refs.length === 0) return null;

  return (
    <details style={{ marginTop: 12, borderTop: `1px solid ${C.border}`, paddingTop: 8, fontSize: T.xs }}>
      <summary class="ag-sub" style={{ display: 'flex', alignItems: 'center', gap: 6, color: C.body, fontWeight: 500, padding: '2px 0' }}>
        <IconChevron size={12} />
        Un-redact a region for this session
        <span style={{ marginLeft: 'auto', color: C.muted, fontWeight: 400 }}>{refs.length} item{refs.length === 1 ? '' : 's'}</span>
      </summary>
      <div style={{ color: C.secondary, margin: '6px 0 4px' }}>The real value is shown to the model from the next step on. A reason is required.</div>
      {refs.map(({ ref, entity }) => {
        const hasReason = Boolean((reasons[ref] ?? '').trim());
        const isDone = done.has(ref);

        return (
          <div key={ref} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 0', flexWrap: 'wrap' }}>
            <span style={{ flex: '1 0 110px', minWidth: 0, color: C.body, fontWeight: 500 }}>
              {entityLabel(entity)} <span style={{ ...S.mono, color: C.muted, fontWeight: 400 }}>{ref}</span>
            </span>
            {isDone ? (
              <span style={{ color: C.ok, fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <IconCheck size={12} /> un-redacted
              </span>
            ) : (
              <span style={{ display: 'flex', gap: 6, flex: '2 1 180px' }}>
                <input
                  type="text"
                  placeholder="Reason"
                  aria-label={`Reason to un-redact ${ref}`}
                  value={reasons[ref] ?? ''}
                  onInput={(e) => setReasons((prev) => ({ ...prev, [ref]: (e.target as HTMLInputElement).value }))}
                  style={{
                    flex: 1,
                    padding: '5px 8px',
                    fontSize: T.xs,
                    border: `1px solid ${C.borderMid}`,
                    borderRadius: R.sm,
                    background: C.white,
                    outline: 'none',
                    minWidth: 0,
                  }}
                />
                <button
                  class="ag-ghost"
                  disabled={!hasReason}
                  onClick={() => {
                    if (hasReason) {
                      onUnredact(ref, (reasons[ref] ?? '').trim());
                      setDone((prev) => new Set(prev).add(ref));
                    }
                  }}
                  style={{
                    ...S.btnSecondary,
                    fontSize: T.xs,
                    padding: '5px 10px',
                    opacity: !hasReason ? 0.45 : 1,
                    cursor: !hasReason ? 'not-allowed' : 'pointer',
                  }}
                >
                  Un-redact
                </button>
              </span>
            )}
          </div>
        );
      })}
    </details>
  );
}

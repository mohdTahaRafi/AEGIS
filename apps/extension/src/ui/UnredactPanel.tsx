// design.md §7.1 step 9 / FR-36 (T-6.12) — user-un-redact action.
// Redesigned: clean card layout, compact inputs, clear validation.

import { useState } from 'preact/hooks';
import type { SanitizedContext } from '@aegis/protocol';
import { C, R, S, T } from './design';

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
    <div
      style={{
        fontSize: T.xs,
        margin: '8px 0',
        border: `1px solid ${C.border}`,
        borderRadius: R.sm,
        padding: '8px 10px',
        background: C.bg,
      }}
    >
      <div style={{ fontWeight: 600, color: C.strong, marginBottom: 6 }}>
        Un-redact a region for this session
      </div>
      {refs.map(({ ref, entity }) => {
        const hasReason = Boolean((reasons[ref] ?? '').trim());
        const isDone = done.has(ref);

        return (
          <div key={ref} style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '5px 0' }}>
            <span style={{ flex: '0 0 auto', minWidth: 120, color: C.body, fontWeight: 500 }}>
              {entity} <span style={{ color: C.muted, fontWeight: 400 }}>{ref}</span>
            </span>
            {isDone ? (
              <span style={{ color: C.ok, fontWeight: 500 }}>✓ un-redacted</span>
            ) : (
              <>
                <input
                  type="text"
                  placeholder="reason"
                  value={reasons[ref] ?? ''}
                  onInput={(e) => setReasons((prev) => ({ ...prev, [ref]: (e.target as HTMLInputElement).value }))}
                  style={{
                    flex: 1,
                    padding: '4px 8px',
                    fontSize: T.xs,
                    border: `1px solid ${C.borderMid}`,
                    borderRadius: R.sm,
                    background: C.white,
                    outline: 'none',
                    minWidth: 0,
                  }}
                />
                <button
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
                    padding: '4px 10px',
                    opacity: !hasReason ? 0.45 : 1,
                    cursor: !hasReason ? 'not-allowed' : 'pointer',
                  }}
                >
                  Un-redact
                </button>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

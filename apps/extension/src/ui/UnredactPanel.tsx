// design.md §7.1 step 9 / FR-36 (T-6.12) — the one UI surface for the session's own
// user-un-redact action. Lists every distinct resolvable ref from the current step's own
// `redactions[]` (a bare, non-resolvable `⟪ENTITY⟫` has no ref to un-redact at all) with a reason
// field, since `Session.unredact` records that reason to the ledger — a reason is asked for here,
// not defaulted, so the audit trail says something a reviewer can actually use.

import { useState } from 'preact/hooks';
import type { SanitizedContext } from '@aegis/protocol';

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
    <div style={{ fontSize: 12, margin: '8px 0', border: '1px solid #ddd', borderRadius: 4, padding: 6 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Un-redact a region for this session</div>
      {refs.map(({ ref, entity }) => (
        <div key={ref} style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '4px 0' }}>
          <span style={{ flex: '0 0 140px' }}>
            {entity} {ref}
          </span>
          {done.has(ref) ? (
            <span style={{ color: '#080' }}>un-redacted</span>
          ) : (
            <>
              <input
                type="text"
                placeholder="reason"
                value={reasons[ref] ?? ''}
                onInput={(e) => setReasons((prev) => ({ ...prev, [ref]: (e.target as HTMLInputElement).value }))}
                style={{ flex: 1 }}
              />
              <button
                disabled={!(reasons[ref] ?? '').trim()}
                onClick={() => {
                  onUnredact(ref, (reasons[ref] ?? '').trim());
                  setDone((prev) => new Set(prev).add(ref));
                }}
              >
                Un-redact
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

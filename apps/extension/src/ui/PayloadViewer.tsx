// design.md §9/§13.1 (T-3.32, FR-34, AC-9) — "the user (and judges) shall be able to see exactly
// what was sent for each step." No image this phase (Phase 4) — the raw-JSON expander is the
// whole of it; `RedactionSummary` (siblings this in the panel) covers the counts.

import { useState } from 'preact/hooks';
import type { SanitizedContext } from '@aegis/protocol';

export interface PayloadViewerProps {
  payload: SanitizedContext;
}

export function PayloadViewer({ payload }: PayloadViewerProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{ margin: '8px 0', fontSize: 12 }}>
      <button onClick={() => setExpanded((v) => !v)}>{expanded ? 'Hide' : 'Show'} exact bytes sent</button>
      {expanded && (
        <pre
          style={{ background: '#111', color: '#eee', padding: 8, borderRadius: 4, overflow: 'auto', maxHeight: 300, fontSize: 11 }}
        >
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

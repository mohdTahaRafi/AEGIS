// design.md §9/§13.1 (T-3.32, FR-34, AC-9) — "the user (and judges) shall be able to see exactly
// what was sent for each step." Phase 3 shipped the raw-JSON expander only (no image existed
// yet); Phase 4 (T-4.22) adds the image pane — "the payload viewer now has two panes... on the
// left, the image the server received." Side-by-side is a two-column flex layout, not a
// dedicated image-diff widget — no image-comparison UI was built, only a plain `<img>` of the
// composed bytes, which already carries everything the milestone description asks to see.

import { useState } from 'preact/hooks';
import type { SanitizedContext } from '@aegis/protocol';

export interface PayloadViewerProps {
  payload: SanitizedContext;
}

export function PayloadViewer({ payload }: PayloadViewerProps) {
  const [expanded, setExpanded] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const image = payload.image;

  return (
    <div style={{ margin: '8px 0', fontSize: 12 }}>
      <button onClick={() => setExpanded((v) => !v)}>{expanded ? 'Hide' : 'Show'} exact bytes sent</button>
      {expanded && (
        <div style={{ display: 'flex', gap: 8, flexWrap: zoomed ? 'wrap' : 'nowrap' }}>
          {image && (
            <div style={{ flex: zoomed ? '1 1 100%' : '0 0 auto' }}>
              <img
                src={`data:image/webp;base64,${image.data}`}
                alt="Sanitized image sent to the server"
                title="Click to enlarge"
                onClick={() => setZoomed((z) => !z)}
                style={{ width: zoomed ? '100%' : 240, border: '1px solid #333', cursor: 'zoom-in' }}
              />
              <div style={{ color: '#666', maxWidth: zoomed ? undefined : 240 }}>{image.legend}</div>
            </div>
          )}
          <pre
            style={{ flex: 1, background: '#111', color: '#eee', padding: 8, borderRadius: 4, overflow: 'auto', maxHeight: 300, fontSize: 11 }}
          >
            {JSON.stringify(payload, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

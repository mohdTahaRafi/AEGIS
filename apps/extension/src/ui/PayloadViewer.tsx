// design.md §9/§13.1 (T-3.32, FR-34, AC-9) — exact bytes sent for each step.
// Redesigned: clean inspection button, side-by-side or stacked view, styled code block.

import { useState } from 'preact/hooks';
import type { SanitizedContext } from '@aegis/protocol';
import { C, R, S, T } from './design';

export interface PayloadViewerProps {
  payload: SanitizedContext;
}

export function PayloadViewer({ payload }: PayloadViewerProps) {
  const [expanded, setExpanded] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const image = payload.image;

  return (
    <div style={{ margin: '8px 0', fontSize: T.xs }}>
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          ...S.btnSecondary,
          fontSize: T.xs,
          padding: '4px 10px',
        }}
      >
        {expanded ? 'Hide' : 'Show'} exact bytes sent
      </button>

      {expanded && (
        <div style={{ display: 'flex', gap: 10, flexWrap: zoomed ? 'wrap' : 'nowrap', marginTop: 8 }}>
          {image && (
            <div style={{ flex: zoomed ? '1 1 100%' : '0 0 auto' }}>
              <img
                src={`data:image/webp;base64,${image.data}`}
                alt="Sanitized image sent to the server"
                title="Click to enlarge"
                onClick={() => setZoomed((z) => !z)}
                style={{
                  width: zoomed ? '100%' : 220,
                  border: `1px solid ${C.borderMid}`,
                  borderRadius: R.sm,
                  cursor: 'zoom-in',
                  display: 'block',
                }}
              />
              <div style={{ color: C.secondary, fontSize: T.xs, marginTop: 4, maxWidth: zoomed ? undefined : 220 }}>
                {image.legend}
              </div>
            </div>
          )}
          <pre
            style={{
              flex: 1,
              background: '#1e293b',
              color: '#f8fafc',
              padding: '8px 10px',
              borderRadius: R.sm,
              overflow: 'auto',
              maxHeight: 280,
              fontSize: 11,
              lineHeight: 1.4,
              fontFamily: 'ui-monospace, "SFMono-Regular", Consolas, monospace',
              margin: 0,
            }}
          >
            {JSON.stringify(payload, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

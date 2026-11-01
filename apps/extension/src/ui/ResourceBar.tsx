// phase_4_vision.md T-4.22/T-4.23 — on-device perception backend and total model memory, as the
// second line of the status strip under the header.
import { C } from './design';
import { statusLine, strongValue } from './MetricsBar';

export interface ResourceBarProps {
  backend: 'webgpu' | 'wasm' | null;
  modelsLoadedMB: number;
  /** Per-model providers or why WebGPU was refused, e.g. "YuNet wasm · CLIP wasm". */
  detail?: string;
}

const BACKEND_LABEL = { webgpu: 'WebGPU', wasm: 'WASM' } as const;

export function ResourceBar({ backend, modelsLoadedMB, detail }: ResourceBarProps) {
  return (
    <div style={statusLine}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: backend ? C.ok : C.muted, flexShrink: 0 }} />
        <span>
          On-device vision: <span style={strongValue}>{backend ? `ready · ${BACKEND_LABEL[backend]}` : 'not loaded yet'}</span>
        </span>
      </span>
      <span>
        Models: <span style={strongValue}>{modelsLoadedMB.toFixed(1)} MB</span>
      </span>
      {detail && (
        <span data-testid="backend-detail" style={{ color: C.muted, flexBasis: '100%' }}>
          {detail}
        </span>
      )}
    </div>
  );
}

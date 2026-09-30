// phase_4_vision.md T-4.22/T-4.23 — on-device perception backend and total model memory.
// Redesigned: clean metadata row matching MetricsBar with subtle badge styling.
import { C, T } from './design';

export interface ResourceBarProps {
  backend: 'webgpu' | 'wasm' | null;
  modelsLoadedMB: number;
  /** Per-model providers or why WebGPU was refused, e.g. "YuNet wasm · CLIP wasm". */
  detail?: string;
}

export function ResourceBar({ backend, modelsLoadedMB, detail }: ResourceBarProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        fontSize: T.xs,
        color: C.secondary,
        padding: '5px 0',
        borderBottom: `1px solid ${C.border}`,
      }}
    >
      <span>
        vision: <span style={{ color: C.body, fontWeight: backend ? 500 : 400 }}>{backend ?? 'idle (models load when a task runs, unload after)'}</span>
      </span>

      {detail && (
        <span data-testid="backend-detail" style={{ color: C.muted }}>
          {detail}
        </span>
      )}

      <span style={{ marginLeft: 'auto' }}>
        models: <span style={{ color: C.body, fontWeight: 500 }}>{modelsLoadedMB.toFixed(1)} MB</span>
      </span>
    </div>
  );
}

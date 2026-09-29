// phase_4_vision.md T-4.22/T-4.23 — "the resource bar shows backend, models loaded and total MB."
// Distinct from `MetricsBar` (the gateway's live/replay serving mode, phase_2_spine.md §7) —
// this is the ON-DEVICE perception backend, metric 4's headline number.

export interface ResourceBarProps {
  backend: 'webgpu' | 'wasm' | null;
  modelsLoadedMB: number;
  /** Per-model providers or why WebGPU was refused, e.g. "YuNet wasm · CLIP wasm". */
  detail?: string;
}

export function ResourceBar({ backend, modelsLoadedMB, detail }: ResourceBarProps) {
  return (
    <div style={{ display: 'flex', gap: 12, fontSize: 12, color: '#444', padding: '4px 0', borderBottom: '1px solid #eee' }}>
      <span>vision: {backend ?? 'idle (models load when a task runs, unload after)'}</span>
      {detail && <span data-testid="backend-detail">{detail}</span>}
      <span>models: {modelsLoadedMB.toFixed(1)} MB</span>
    </div>
  );
}

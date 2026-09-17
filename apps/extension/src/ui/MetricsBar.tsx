// phase_2_spine.md §7 (T-2.28) — backend, memory estimate and per-step latency, updating live as
// `steps` grows. "Backend" is the gateway's serving mode (live model vs. record/replay, T-2.39) —
// the client only ever gets to say what it was told, not what mode is authoritative.
import type { StepRecord } from '../host/session';

export interface MetricsBarProps {
  backend: 'live' | 'replay' | 'not connected';
  steps: StepRecord[];
}

const STAGE_ORDER: Array<keyof StepRecord['stageTimings']> = ['observe', 'perceive', 'sanitize', 'guard', 'server', 'validate', 'act'];

function stepTotal(step: StepRecord): number {
  return STAGE_ORDER.reduce((sum, stage) => sum + step.stageTimings[stage], 0);
}

function deviceMemoryLabel(): string {
  const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return deviceMemory !== undefined ? `~${deviceMemory} GB` : 'unreported';
}

export function MetricsBar({ backend, steps }: MetricsBarProps) {
  const lastStep = steps.at(-1);
  return (
    <div style={{ display: 'flex', gap: 12, fontSize: 12, color: '#444', padding: '4px 0', borderBottom: '1px solid #eee' }}>
      <span>backend: {backend}</span>
      <span>memory: {deviceMemoryLabel()}</span>
      <span>last step: {lastStep ? `${stepTotal(lastStep).toFixed(0)} ms` : '—'}</span>
    </div>
  );
}

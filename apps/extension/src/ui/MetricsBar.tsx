// phase_2_spine.md §7 (T-2.28) — backend, memory estimate and per-step latency, updating live as
// `steps` grows. Redesigned: minimal, compact status strip with subtle status dots.
import type { StepRecord } from '../host/session';
import { C, T } from './design';

export interface MetricsBarProps {
  backend: 'live' | 'record' | 'replay' | 'not connected';
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

const BACKEND_DOT: Record<MetricsBarProps['backend'], string> = {
  live: C.ok,
  record: C.warn,
  replay: C.warn,
  'not connected': C.muted,
};

export function MetricsBar({ backend, steps }: MetricsBarProps) {
  const lastStep = steps.at(-1);
  const dot = BACKEND_DOT[backend];

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
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: dot,
            display: 'inline-block',
            flexShrink: 0,
          }}
        />
        <span>backend: {backend}</span>
      </span>

      <span>
        memory: <span style={{ color: C.body }}>{deviceMemoryLabel()}</span>
      </span>

      <span style={{ marginLeft: 'auto' }}>
        last step: <span style={{ color: C.body, fontWeight: lastStep ? 500 : 400 }}>{lastStep ? `${stepTotal(lastStep).toFixed(0)} ms` : '—'}</span>
      </span>
    </div>
  );
}

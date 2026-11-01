// phase_2_spine.md §7 (T-2.28) — model connection, memory estimate and per-step latency, updating
// live as `steps` grows. Rendered as one quiet line of labelled values under the header.
import type { StepRecord } from '../host/session';
import { C, T } from './design';

export interface MetricsBarProps {
  backend: 'live' | 'record' | 'replay' | 'not connected';
  steps: StepRecord[];
  /** The model tasks will use, and whether its key is saved; before a task has connected this
   * says whether one can (a bring-your-own-key build has no connection until Run). */
  model?: { name: string; keySaved: boolean };
}

const STAGE_ORDER: Array<keyof StepRecord['stageTimings']> = ['observe', 'perceive', 'sanitize', 'guard', 'server', 'validate', 'act'];

function stepTotal(step: StepRecord): number {
  return STAGE_ORDER.reduce((sum, stage) => sum + step.stageTimings[stage], 0);
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

function deviceMemoryLabel(): string {
  const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return deviceMemory !== undefined ? `~${deviceMemory} GB` : 'unreported';
}

function connection(backend: MetricsBarProps['backend'], model: MetricsBarProps['model']): { text: string; color: string } {
  if (backend === 'live') return { text: 'connected', color: C.ok };
  if (backend === 'record' || backend === 'replay') return { text: backend, color: C.warn };
  if (model) return model.keySaved ? { text: 'ready', color: C.ok } : { text: 'no API key', color: C.warn };
  return { text: 'not connected', color: C.muted };
}

export const statusLine = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  columnGap: 14,
  rowGap: 2,
  fontSize: T.xs,
  color: C.secondary,
  lineHeight: 1.6,
} as const;

export const strongValue = { color: C.body, fontWeight: 500 } as const;

export function MetricsBar({ backend, steps, model }: MetricsBarProps) {
  const lastStep = steps.at(-1);
  const conn = connection(backend, model);

  return (
    <div style={statusLine}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: conn.color, flexShrink: 0 }} />
        <span>
          Model: <span style={strongValue}>{model ? `${model.name} · ${conn.text}` : conn.text}</span>
        </span>
      </span>
      <span>
        Last step: <span style={strongValue}>{lastStep ? formatMs(stepTotal(lastStep)) : '—'}</span>
      </span>
      <span>
        Memory: <span style={strongValue}>{deviceMemoryLabel()}</span>
      </span>
    </div>
  );
}

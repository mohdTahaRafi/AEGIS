// phase_2_spine.md §7 (T-2.27) — one card per step, per-stage timings summing to the step total.
// Redesigned: clean card presentation with subtle borders and clear metrics.
import type { StepRecord } from '../host/session';
import { C, R, T } from './design';

export interface StepTimelineProps {
  steps: StepRecord[];
}

const STAGE_ORDER: Array<keyof StepRecord['stageTimings']> = ['observe', 'perceive', 'sanitize', 'guard', 'server', 'validate', 'act'];

function stepTotal(step: StepRecord): number {
  return STAGE_ORDER.reduce((sum, stage) => sum + step.stageTimings[stage], 0);
}

export function StepTimeline({ steps }: StepTimelineProps) {
  if (steps.length === 0) {
    return <p style={{ color: C.secondary, fontSize: T.xs, margin: '8px 0' }}>No steps yet.</p>;
  }
  return (
    <ol style={{ listStyle: 'none', padding: 0, margin: '8px 0' }}>
      {steps.map((step) => (
        <li
          key={step.stepId}
          style={{
            border: `1px solid ${C.border}`,
            borderRadius: R.sm,
            padding: '8px 10px',
            marginBottom: 6,
            background: C.surface,
          }}
        >
          <div style={{ fontWeight: 600, fontSize: T.sm, color: C.strong, marginBottom: 2 }}>
            Step {step.stepIndex} — {step.outcome} ({stepTotal(step).toFixed(0)} ms)
          </div>
          <div style={{ color: C.secondary, fontSize: T.xs, margin: '2px 0' }}>
            {STAGE_ORDER.map((stage) => `${stage} ${step.stageTimings[stage].toFixed(0)}ms`).join(' · ')}
          </div>
          <div style={{ fontSize: T.xs, color: C.muted }}>
            {step.actionsPlanned} action(s) planned
          </div>
        </li>
      ))}
    </ol>
  );
}

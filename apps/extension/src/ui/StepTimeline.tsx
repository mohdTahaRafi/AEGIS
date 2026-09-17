// phase_2_spine.md §7 (T-2.27) — one card per step, per-stage timings summing to the step total
// (design.md's milestone demo script: "Step 1 — observe 7 ms · sanitize 1 ms · guard 0 ms ·
// server 640 ms · validate 2 ms · act 9 ms").
import type { StepRecord } from '../host/session';

export interface StepTimelineProps {
  steps: StepRecord[];
}

const STAGE_ORDER: Array<keyof StepRecord['stageTimings']> = ['observe', 'perceive', 'sanitize', 'guard', 'server', 'validate', 'act'];

function stepTotal(step: StepRecord): number {
  return STAGE_ORDER.reduce((sum, stage) => sum + step.stageTimings[stage], 0);
}

export function StepTimeline({ steps }: StepTimelineProps) {
  if (steps.length === 0) {
    return <p style={{ color: '#666' }}>No steps yet.</p>;
  }
  return (
    <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {steps.map((step) => (
        <li key={step.stepId} style={{ border: '1px solid #ddd', borderRadius: 4, padding: 8, marginBottom: 6 }}>
          <div style={{ fontWeight: 600 }}>
            Step {step.stepIndex} — {step.outcome} ({stepTotal(step).toFixed(0)} ms)
          </div>
          <div style={{ color: '#666', fontSize: 12 }}>
            {STAGE_ORDER.map((stage) => `${stage} ${step.stageTimings[stage].toFixed(0)}ms`).join(' · ')}
          </div>
          <div style={{ fontSize: 12 }}>{step.actionsPlanned} action(s) planned</div>
        </li>
      ))}
    </ol>
  );
}

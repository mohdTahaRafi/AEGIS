// The task being worked on, how long it has run, and where its current step is in the pipeline:
// scan and redact on this device → send the redacted view and wait for the model → check the
// model's plan → act on the page. Every stage state is read from the run log (session events),
// never from a timer or an assumption; the full detail of every step stays in the activity log.

import { useEffect, useState } from 'preact/hooks';
import type { PanelState } from './PanelStates';
import { planOf, rejectionOf, type RunLog, type StepLog } from './RunLog';
import { formatMs } from './MetricsBar';
import { IconCheck, IconMinus, IconSpinner, IconX } from './icons';
import { C, R, S, T } from './design';

export type StageState = 'pending' | 'active' | 'complete' | 'failed' | 'skipped' | 'cancelled';

export interface ProgressStage {
  title: string;
  state: StageState;
  detail?: string;
  ms?: number;
}

export type TaskStatus = 'processing' | 'waiting' | 'completed' | 'failed' | 'cancelled';

export function taskStatus(panelState: PanelState, log: RunLog): TaskStatus {
  if (panelState === 'awaiting-confirmation' || panelState === 'awaiting-grant' || panelState === 'awaiting-user') return 'waiting';
  if (panelState === 'running' || panelState === 'loading') return 'processing';
  if (log.result?.kind === 'done' || panelState === 'done') return 'completed';
  if (log.result?.kind === 'stopped' && log.result.text.startsWith('CANCELLED')) return 'cancelled';
  if (panelState === 'idle' && !log.result) return 'cancelled';
  return 'failed';
}

/** The four stages of `step` (the latest one). `live`: the task is still running, so a stage that
 * has started but not finished is in progress rather than cut short. */
export function stepStages(step: StepLog | undefined, live: boolean, ended: 'failed' | 'cancelled'): ProgressStage[] {
  const t = step?.record?.stageTimings;
  const payload = step?.payload;
  const blocked = Boolean(step?.guardBlock && !payload);
  const plan = step ? planOf(step) : undefined;
  const rejected = step ? rejectionOf(step) : undefined;
  const serverFailed = step?.serverNotes.find((n) => n.startsWith('no plan'));
  const replied = Boolean(plan || rejected || t);

  const scan: ProgressStage = { title: 'Scan the page and hide private data on this device', state: 'pending' };
  if (blocked) {
    scan.state = 'failed';
    scan.detail = `The privacy guard stopped this step (${step!.guardBlock!.rule}). Nothing was sent.`;
  } else if (payload) {
    scan.state = 'complete';
    const n = payload.redactions.length;
    scan.detail = n === 0 ? 'Nothing private found on screen' : `${n} item${n === 1 ? '' : 's'} hidden before sending`;
    if (t) scan.ms = t.observe + t.perceive + t.sanitize + t.guard;
  } else if (step) {
    scan.state = 'active';
    scan.detail = step.perception ? 'Checking the page and screenshot locally…' : 'Reading the page…';
  }

  const send: ProgressStage = { title: 'Send the redacted view to the model', state: 'pending' };
  if (blocked) {
    send.state = 'skipped';
    send.detail = 'Not sent';
  } else if (payload && serverFailed) {
    send.state = 'failed';
    send.detail = serverFailed.replace(/^no plan: /, '');
  } else if (payload && replied) {
    send.state = 'complete';
    send.detail = payload.image ? 'Redacted screenshot and page outline sent' : 'Page outline sent (no screenshot)';
    if (t) send.ms = t.server;
  } else if (payload) {
    send.state = 'active';
    send.detail = step!.serverNotes.at(-1) ?? 'Waiting for the model to reply…';
  }

  const check: ProgressStage = { title: "Check the model's plan", state: 'pending' };
  if (blocked) check.state = 'skipped';
  else if (rejected) {
    check.state = 'failed';
    check.detail = `Refused on this device: ${rejected.reason}`;
  } else if (plan) {
    check.state = 'complete';
    check.detail = `${plan.actions.length} action${plan.actions.length === 1 ? '' : 's'} approved`;
    if (t) check.ms = t.validate;
  }

  const act: ProgressStage = { title: 'Act on the page', state: 'pending' };
  if (blocked || rejected) act.state = 'skipped';
  else if (plan) {
    const running = plan.actions.find((a) => a.status === 'validated');
    const executed = plan.actions.filter((a) => a.status === 'executed').length;
    const failed = plan.actions.filter((a) => a.status === 'failed' || a.status === 'declined').length;
    if (running && !t) {
      act.state = 'active';
      act.detail = running.text;
    } else {
      act.state = failed > 0 ? 'failed' : 'complete';
      act.detail = `${executed} of ${plan.actions.length} executed${failed > 0 ? `, ${failed} not` : ''}`;
      if (t) act.ms = t.act;
    }
  }

  const stages = [scan, send, check, act];
  if (!live) for (const s of stages) if (s.state === 'active') s.state = ended;
  return stages;
}

function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000);
  return sec < 60 ? `${sec} s` : `${Math.floor(sec / 60)} min ${sec % 60} s`;
}

const STATUS_BADGE: Record<TaskStatus, { label: string; color: string; bg: string }> = {
  processing: { label: 'In progress', color: C.accent, bg: C.accentSoft },
  waiting: { label: 'Needs you', color: C.warn, bg: C.warnBg },
  completed: { label: 'Completed', color: C.ok, bg: C.okBg },
  failed: { label: 'Failed', color: C.error, bg: C.errorBg },
  cancelled: { label: 'Cancelled', color: C.secondary, bg: '#f1f3f5' },
};

function StageIcon({ state, index }: { state: StageState; index: number }) {
  const base = { width: 20, height: 20, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 10.5, fontWeight: 600 } as const;
  switch (state) {
    case 'complete':
      return (
        <span style={{ ...base, background: C.okBg, color: C.ok, border: `1px solid ${C.okBorder}` }}>
          <IconCheck size={11} />
        </span>
      );
    case 'active':
      return (
        <span style={{ ...base, background: C.accentSoft, color: C.accent, border: `1px solid ${C.infoBorder}` }}>
          <IconSpinner size={11} />
        </span>
      );
    case 'failed':
      return (
        <span style={{ ...base, background: C.errorBg, color: C.error, border: `1px solid ${C.errorBorder}` }}>
          <IconX size={11} />
        </span>
      );
    case 'skipped':
    case 'cancelled':
      return (
        <span style={{ ...base, background: C.bg, color: C.muted, border: `1px solid ${C.border}` }}>
          <IconMinus size={11} />
        </span>
      );
    default:
      return <span style={{ ...base, background: C.white, color: C.muted, border: `1px solid ${C.borderMid}` }}>{index + 1}</span>;
  }
}

function useElapsed(startedAt: number | null, live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live, startedAt]);
  return startedAt === null ? 0 : Math.max(0, now - startedAt);
}

export interface TaskProgressProps {
  task: string;
  startedAt: number | null;
  panelState: PanelState;
  log: RunLog;
}

export function TaskProgress({ task, startedAt, panelState, log }: TaskProgressProps) {
  const status = taskStatus(panelState, log);
  const live = status === 'processing' || status === 'waiting';
  const elapsed = useElapsed(startedAt, live);
  const step = log.steps.at(-1);
  const stages = stepStages(step, live, status === 'cancelled' ? 'cancelled' : 'failed');
  const badge = STATUS_BADGE[status];
  // A finished task's answer card says how it ended; the stages stay for one that did not finish.
  const showStages = status !== 'completed' && (live || log.steps.length > 0);

  return (
    <section data-testid="task-progress" style={{ ...S.card, padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={S.eyebrow}>Current task</span>
        <span
          style={{
            marginLeft: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            padding: '2px 8px',
            borderRadius: 100,
            fontSize: T.xs,
            fontWeight: 600,
            color: badge.color,
            background: badge.bg,
          }}
        >
          {live && <span class="ag-pulse" style={S.dot(badge.color)} />}
          {badge.label}
        </span>
      </div>
      <div style={{ fontSize: T.md, color: C.strong, fontWeight: 500, lineHeight: 1.4, overflowWrap: 'anywhere' }}>{task}</div>
      <div style={{ display: 'flex', gap: 12, fontSize: T.xs, color: C.secondary, marginTop: 4 }}>
        {startedAt !== null && <span>{formatElapsed(elapsed)}</span>}
        {log.steps.length > 0 && (
          <span>
            Step {log.steps.length}
            {live ? ' in progress' : ''}
          </span>
        )}
        {log.steps.length === 0 && live && log.setup.length > 0 && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{log.setup.at(-1)}</span>}
      </div>

      {showStages && (
        <ol style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
          {stages.map((s, i) => (
            <li key={i} data-stage-state={s.state} style={{ display: 'flex', gap: 10, position: 'relative', paddingBottom: i < stages.length - 1 ? 10 : 0 }}>
              {i < stages.length - 1 && (
                <span aria-hidden="true" style={{ position: 'absolute', left: 9.5, top: 22, bottom: 0, width: 1, background: s.state === 'complete' ? C.okBorder : C.border }} />
              )}
              <StageIcon state={s.state} index={i} />
              <div style={{ flex: 1, minWidth: 0, paddingTop: 1 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span
                    style={{
                      fontSize: T.sm,
                      fontWeight: s.state === 'active' ? 600 : 500,
                      color: s.state === 'pending' || s.state === 'skipped' || s.state === 'cancelled' ? C.secondary : C.strong,
                    }}
                  >
                    {s.title}
                  </span>
                  {s.ms !== undefined && <span style={{ marginLeft: 'auto', fontSize: T.xs, color: C.muted, whiteSpace: 'nowrap' }}>{formatMs(s.ms)}</span>}
                </div>
                {s.detail && (
                  <div
                    style={{
                      fontSize: T.xs,
                      color: s.state === 'failed' ? C.error : C.secondary,
                      marginTop: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                    }}
                  >
                    {s.detail}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

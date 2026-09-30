// The run log as collapsible sections, in execution order: setup → each step (on this device →
// sent to the server → the server model's reply → executed on the page → timings) → result →
// this session's redactions.
// Redesigned: minimal, professional collapsible panels with clear information hierarchy.

import { describeWorkerProblem } from './worker-problem';
import type { ComponentChildren } from 'preact';
import type { WorkerProblem } from '../host/perception-client/client';
import type { ModelLoadFailure } from '../shared/worker-protocol';
import { STATUS_STYLE } from './ActivityLog';
import { PayloadViewer } from './PayloadViewer';
import { PerceptionStatus } from './PerceptionStatus';
import type { RunLog, StepLog } from './RunLog';
import { C, R, T } from './design';

const STAGES = ['observe', 'perceive', 'sanitize', 'guard', 'server', 'validate', 'act'] as const;

export function Section({
  title,
  summary,
  open,
  children,
  testId,
}: {
  title: string;
  summary?: string;
  open?: boolean;
  children: ComponentChildren;
  testId?: string;
}) {
  return (
    <details
      open={open}
      data-testid={testId}
      style={{
        border: `1px solid ${C.border}`,
        borderRadius: R.md,
        margin: '8px 0',
        background: C.surface,
        overflow: 'hidden',
      }}
    >
      <summary
        style={{
          cursor: 'pointer',
          padding: '8px 12px',
          background: C.bg,
          borderBottom: open ? `1px solid ${C.border}` : 'none',
          fontSize: T.sm,
          fontWeight: 600,
          color: C.strong,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          userSelect: 'none',
        }}
      >
        <span>{title}</span>
        {summary && (
          <span style={{ fontSize: T.xs, fontWeight: 400, color: C.secondary }}>
            {summary}
          </span>
        )}
      </summary>
      <div style={{ padding: '10px 12px', lineHeight: 1.45, fontSize: T.sm }}>{children}</div>
    </details>
  );
}

function SubSection({
  title,
  summary,
  open,
  children,
}: {
  title: string;
  summary?: string;
  open?: boolean;
  children: ComponentChildren;
}) {
  return (
    <details
      open={open}
      style={{
        margin: '6px 0',
        borderLeft: `2px solid ${C.borderMid}`,
        paddingLeft: 10,
      }}
    >
      <summary
        style={{
          cursor: 'pointer',
          fontWeight: 600,
          fontSize: T.xs,
          color: C.strong,
          padding: '2px 0',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          userSelect: 'none',
        }}
      >
        <span>{title}</span>
        {summary && (
          <span style={{ fontWeight: 400, color: C.secondary, fontSize: T.xs }}>
            {summary}
          </span>
        )}
      </summary>
      <div style={{ padding: '4px 0 2px 2px', fontSize: T.xs, color: C.body }}>{children}</div>
    </details>
  );
}

/** The model writes Markdown `**bold**`; render just that (as elements, so nothing is parsed as HTML). */
export function withBold(text: string): ComponentChildren[] {
  return text.split('**').map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : part));
}

function TextBox({ label, text }: { label: string; text: string }) {
  return (
    <div
      style={{
        border: `1px solid ${C.border}`,
        background: C.bg,
        borderRadius: R.sm,
        padding: '6px 10px',
        margin: '6px 0',
      }}
    >
      <div style={{ fontWeight: 600, fontSize: T.xs, color: C.strong, marginBottom: 2 }}>{label}</div>
      <div style={{ whiteSpace: 'pre-wrap', color: C.body, fontSize: T.xs, lineHeight: 1.4 }}>
        {text ? withBold(text) : '(no text)'}
      </div>
    </div>
  );
}

const ms = (v: number | undefined) => (v === undefined ? '…' : `${Math.round(v)} ms`);

function stepTotal(step: StepLog): number | undefined {
  const t = step.record?.stageTimings;
  return t ? STAGES.reduce((sum, k) => sum + t[k], 0) : undefined;
}

function planOf(step: StepLog) {
  for (const e of step.activity) if (e.kind === 'plan') return e;
  return undefined;
}

function rejectionOf(step: StepLog) {
  for (const e of step.activity) if (e.kind === 'rejected') return e;
  return undefined;
}

function outcomeLabel(step: StepLog, isLast: boolean, running: boolean): string {
  if (step.guardBlock && !step.payload) return 'blocked by the guard';
  if (step.record) return step.record.outcome;
  return isLast && running ? 'running…' : 'ended';
}

function base64Kb(data: string): number {
  return Math.round((data.length * 3) / 4 / 1024);
}

function StepSection({
  step,
  index,
  isLast,
  running,
  showRawPayload,
}: {
  step: StepLog;
  index: number;
  isLast: boolean;
  running: boolean;
  showRawPayload: boolean;
}) {
  const t = step.record?.stageTimings;
  const payload = step.payload;
  const plan = planOf(step);
  const rejected = rejectionOf(step);
  const executed = plan?.actions.filter((a) => a.status === 'executed').length ?? 0;
  const total = stepTotal(step);
  const blocked = Boolean(step.guardBlock && !payload);

  return (
    <Section
      testId={`run-step-${step.stepId}`}
      title={`Step ${index + 1} (${step.stepId})`}
      summary={`${outcomeLabel(step, isLast, running)}${total !== undefined ? ` · ${(total / 1000).toFixed(1)} s` : ''}`}
      open={isLast}
    >
      <SubSection
        title="1. On this device: perception and redaction"
        summary={blocked ? `BLOCKED: ${step.guardBlock!.rule}` : payload ? `${payload.redactions.length} redaction(s)` : 'in progress'}
        open={isLast}
      >
        {step.perception ? (
          <PerceptionStatus
            stepId={step.stepId}
            status={step.perception}
            redactions={payload?.redactions ?? []}
            loadFailures={[]}
            workerProblems={[]}
            payload={payload ?? null}
            protectedFields={step.protectedFields}
            timings={t}
            guardBlock={step.guardBlock ?? null}
            localOnly
          />
        ) : (
          <div style={{ color: C.secondary }}>not reached</div>
        )}
      </SubSection>

      <SubSection
        title="2. Sent to the server"
        summary={blocked ? 'nothing sent' : payload ? `${payload.nodes.length} elements · ${payload.image ? 'redacted screenshot' : 'no image'}` : 'not yet'}
      >
        {blocked && (
          <div style={{ color: C.error, fontWeight: 500 }}>
            Nothing was sent: the guard blocked this step ({step.guardBlock!.rule}{step.guardBlock!.entity ? `, ${step.guardBlock!.entity}` : ''}).
          </div>
        )}
        {payload && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div>
              <span style={{ color: C.secondary }}>Task as sent: </span>
              <strong>"{payload.task}"</strong>
            </div>
            <div>
              <span style={{ color: C.secondary }}>Page title as sent: </span>
              <strong>"{payload.page.title}"</strong>
            </div>
            <div>
              {payload.nodes.length} page elements · {payload.text.length} text runs · {payload.history.length} earlier step(s) in history
            </div>
            <div>
              {payload.redactions.length} redaction(s), sent only as placeholders or type labels
              {payload.redactions.length > 0 && `: ${payload.redactions.map((r) => r.ref ?? r.entity).join(', ')}`}
            </div>
            {payload.image ? (
              <div>
                Redacted screenshot: {Math.round(payload.image.region[2])}×{Math.round(payload.image.region[3])} CSS px at scale {payload.image.scale.toFixed(2)}, WebP {base64Kb(payload.image.data)} KB
              </div>
            ) : (
              <div style={{ color: C.secondary }}>No screenshot this step (text only).</div>
            )}
            {showRawPayload && <PayloadViewer payload={payload} />}
          </div>
        )}
      </SubSection>

      <SubSection
        title="3. Server reply (Groq VLM)"
        summary={
          plan
            ? `${plan.actions.length} operation(s)${step.modelTexts.length > 0 ? ' + text' : ''}${t ? ` · ${ms(t.server)}` : ''}`
            : rejected
              ? 'plan rejected'
              : step.serverNotes.length > 0
                ? step.serverNotes.at(-1)!
                : blocked
                  ? 'not asked'
                  : 'waiting'
        }
        open={isLast}
      >
        {step.serverNotes.map((n, i) => (
          <div key={i} style={{ color: n.startsWith('no plan') ? C.error : C.secondary, margin: '2px 0' }}>
            {n}
          </div>
        ))}
        {rejected && (
          <div style={{ color: C.error, fontWeight: 500 }}>
            The extension's validator refused the plan ({rejected.reason}); nothing was executed.
          </div>
        )}
        {plan && (
          <>
            <div style={{ color: C.secondary, marginBottom: 2 }}>
              The model planned {plan.actions.length} operation(s), validated on this device:
            </div>
            <ol style={{ margin: '2px 0', paddingLeft: 18 }}>
              {plan.actions.map((a, i) => (
                <li key={i} style={{ margin: '2px 0' }}>
                  {a.text === 'report' ? 'report (its text is shown below)' : a.text}
                </li>
              ))}
            </ol>
          </>
        )}
        {step.modelTexts.map((m, i) => (
          <TextBox key={i} label={`${m.label} (written by the model)`} text={m.text} />
        ))}
        {!plan && !rejected && step.serverNotes.length === 0 && (
          <div style={{ color: C.secondary }}>{blocked ? 'The server was not asked.' : 'No reply yet.'}</div>
        )}
      </SubSection>

      <SubSection
        title="4. Executed on this page"
        summary={plan ? `${executed} of ${plan.actions.length} executed${t ? ` · ${ms(t.act)}` : ''}` : 'nothing to run'}
        open={isLast}
      >
        {plan ? (
          <ol style={{ margin: '2px 0', paddingLeft: 18 }}>
            {plan.actions.map((a, i) => {
              const st = STATUS_STYLE[a.status];
              return (
                <li key={i} data-status={a.status} style={{ margin: '3px 0' }}>
                  <span>{a.text}</span>{' '}
                  <span style={{ color: st.color, fontWeight: 500 }}>
                    {st.mark} {st.label}
                    {a.reason ? `: ${a.reason}` : ''}
                  </span>
                </li>
              );
            })}
          </ol>
        ) : (
          <div style={{ color: C.secondary }}>No operations.</div>
        )}
        {step.pageNotes.map((n, i) => (
          <div key={i} style={{ color: C.secondary, margin: '2px 0' }}>
            {n}
          </div>
        ))}
      </SubSection>

      {/* Stage Timings footer */}
      <div
        style={{
          color: C.secondary,
          fontSize: T.xs,
          marginTop: 8,
          paddingTop: 6,
          borderTop: `1px solid ${C.border}`,
        }}
      >
        Timings: {STAGES.map((k) => `${k} ${ms(t?.[k])}`).join(' · ')}
      </div>
    </Section>
  );
}

export interface RunLogViewProps {
  log: RunLog;
  running: boolean;
  showRawPayload: boolean;
  loadFailures: ModelLoadFailure[];
  workerProblems: WorkerProblem[];
}

export function RunLogView({ log, running, showRawPayload, loadFailures, workerProblems }: RunLogViewProps) {
  if (log.setup.length === 0 && log.steps.length === 0 && !log.result) return null;
  const lastReport = log.steps
    .flatMap((s) => s.modelTexts)
    .filter((m) => m.label.startsWith('Report') || m.label === 'Question for you')
    .at(-1);

  return (
    <div data-testid="run-log">
      <Section testId="run-setup" title="Setup" summary={`${log.setup.length} event(s)`}>
        <ol style={{ margin: 0, paddingLeft: 18, color: C.body, fontSize: T.xs }}>
          {log.setup.map((line, i) => (
            <li key={i} style={{ margin: '2px 0' }}>{line}</li>
          ))}
        </ol>
        {loadFailures.length > 0 && (
          <div style={{ color: C.error, marginTop: 4, fontWeight: 500 }}>
            Models failed to load: {loadFailures.map((f) => `${f.role} (${f.code})`).join(', ')}
          </div>
        )}
        {workerProblems.length > 0 && (
          <div style={{ color: C.error, marginTop: 4, fontWeight: 500 }}>
            Perception worker: {workerProblems.map((p) => describeWorkerProblem(p)).join(', ')}
          </div>
        )}
      </Section>

      {log.steps.map((step, i) => (
        <StepSection
          key={step.stepId}
          step={step}
          index={i}
          isLast={i === log.steps.length - 1}
          running={running}
          showRawPayload={showRawPayload}
        />
      ))}

      {log.result && (
        <Section testId="run-result" title="Result" summary={log.result.kind === 'done' ? 'done' : 'stopped'} open>
          <div
            style={{
              color: log.result.kind === 'done' ? C.ok : C.error,
              fontWeight: 600,
              fontSize: T.sm,
              marginBottom: lastReport ? 6 : 0,
            }}
          >
            {log.result.kind === 'done' ? `Done: ${log.result.text}` : `Stopped: ${log.result.text}`}
          </div>
          {lastReport && <TextBox label={`${lastReport.label} (written by the model)`} text={lastReport.text} />}
        </Section>
      )}
    </div>
  );
}

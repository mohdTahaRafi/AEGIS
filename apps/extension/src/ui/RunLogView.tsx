// The task's answer (ResultCard), and the run log behind it as one collapsed "Activity log", in
// execution order: setup → each step (on this device → sent to the server → the server model's
// reply → executed on the page → timings). The log keeps every detail for inspection and
// debugging; the main view only needs the answer and the progress card.

import { describeWorkerProblem } from './worker-problem';
import type { ComponentChildren } from 'preact';
import type { WorkerProblem } from '../host/perception-client/client';
import type { ModelLoadFailure } from '../shared/worker-protocol';
import { STATUS_STYLE } from './ActivityLog';
import { PayloadViewer } from './PayloadViewer';
import { PerceptionStatus } from './PerceptionStatus';
import { planOf, rejectionOf, type RunLog, type StepLog } from './RunLog';
import { describeError } from './Notice';
import { formatMs } from './MetricsBar';
import { IconAlert, IconCheck, IconChevron, IconMinus, IconSpinner, IconX } from './icons';
import { C, R, S, T } from './design';

const STAGES = ['observe', 'perceive', 'sanitize', 'guard', 'server', 'validate', 'act'] as const;

export function Section({
  title,
  summary,
  open,
  children,
  testId,
  icon,
  subtitle,
}: {
  title: string;
  summary?: string;
  open?: boolean;
  children: ComponentChildren;
  testId?: string;
  icon?: ComponentChildren;
  subtitle?: string;
}) {
  return (
    <details open={open} data-testid={testId} style={{ borderTop: `1px solid ${C.border}`, background: C.surface }}>
      <summary class="ag-sec" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', fontSize: T.sm }}>
        <span style={{ color: C.muted }}>
          <IconChevron size={13} />
        </span>
        {icon}
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontWeight: 600, color: C.strong }}>{title}</span>
          {subtitle && (
            <span style={{ display: 'block', fontSize: T.xs, color: C.secondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subtitle}</span>
          )}
        </span>
        {summary && <span style={{ fontSize: T.xs, color: C.secondary, whiteSpace: 'nowrap' }}>{summary}</span>}
      </summary>
      <div style={{ padding: '8px 14px 12px 33px', lineHeight: 1.5, fontSize: T.sm, background: C.surface }}>{children}</div>
    </details>
  );
}

function SubSection({ title, summary, open, children }: { title: string; summary?: string; open?: boolean; children: ComponentChildren }) {
  return (
    <details open={open} style={{ margin: '4px 0', borderLeft: `2px solid ${C.border}`, paddingLeft: 10 }}>
      <summary class="ag-sub" style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: T.xs, color: C.strong, padding: '3px 0' }}>
        <span style={{ flex: 1 }}>{title}</span>
        {summary && <span style={{ fontWeight: 400, color: C.secondary, fontSize: T.xs, textAlign: 'right' }}>{summary}</span>}
      </summary>
      <div style={{ padding: '4px 0 6px 2px', fontSize: T.xs, color: C.body }}>{children}</div>
    </details>
  );
}

/** The model writes Markdown `**bold**`; render just that (as elements, so nothing is parsed as HTML). */
export function withBold(text: string): ComponentChildren[] {
  return text.split('**').map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : part));
}

function TextBox({ label, text }: { label: string; text: string }) {
  return (
    <div style={{ border: `1px solid ${C.border}`, background: C.bg, borderRadius: R.sm, padding: '6px 10px', margin: '6px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: T.xs, color: C.strong, marginBottom: 2 }}>
        {label}
        <span style={S.tag(C.secondary, C.border)}>model</span>
      </div>
      <div style={{ whiteSpace: 'pre-wrap', color: C.body, fontSize: T.xs, lineHeight: 1.45 }}>{text ? withBold(text) : '(no text)'}</div>
    </div>
  );
}

const ms = (v: number | undefined) => (v === undefined ? '…' : `${Math.round(v)} ms`);

function stepTotal(step: StepLog): number | undefined {
  const t = step.record?.stageTimings;
  return t ? STAGES.reduce((sum, k) => sum + t[k], 0) : undefined;
}

function outcomeLabel(step: StepLog, isLast: boolean, running: boolean): string {
  if (step.guardBlock && !step.payload) return 'held back by the guard';
  if (step.record) return step.record.outcome;
  return isLast && running ? 'running…' : 'ended';
}

function base64Kb(data: string): number {
  return Math.round((data.length * 3) / 4 / 1024);
}

function stepIcon(step: StepLog, isLast: boolean, running: boolean) {
  const box = (bg: string, fg: string, child: ComponentChildren) => (
    <span style={{ width: 18, height: 18, borderRadius: '50%', background: bg, color: fg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{child}</span>
  );
  const plan = planOf(step);
  const failed = (step.guardBlock && !step.payload) || rejectionOf(step) || plan?.actions.some((a) => a.status === 'failed' || a.status === 'declined');
  if (!step.record && isLast && running) return box(C.accentSoft, C.accent, <IconSpinner size={10} />);
  if (failed) return box(C.errorBg, C.error, <IconX size={10} />);
  if (!step.record) return box(C.bg, C.muted, <IconMinus size={10} />);
  return box(C.okBg, C.ok, <IconCheck size={10} />);
}

/** What the step did, in a few words: its first page operation, as described to the user. */
function stepSubtitle(step: StepLog): string | undefined {
  const plan = planOf(step);
  if (!plan) return step.guardBlock && !step.payload ? `Guard: ${step.guardBlock.rule}` : undefined;
  const first = plan.actions.find((a) => a.text !== 'report')?.text ?? plan.actions[0]?.text;
  if (!first) return undefined;
  return plan.actions.length > 1 ? `${first} (+${plan.actions.length - 1} more)` : first;
}

function StepSection({ step, index, isLast, running, showRawPayload }: { step: StepLog; index: number; isLast: boolean; running: boolean; showRawPayload: boolean }) {
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
      title={`Step ${index + 1}`}
      subtitle={stepSubtitle(step)}
      icon={stepIcon(step, isLast, running)}
      summary={`${outcomeLabel(step, isLast, running)}${total !== undefined ? ` · ${formatMs(total)}` : ''}`}
      open={isLast}
    >
      <div style={{ fontSize: T.xs, color: C.muted, marginBottom: 4 }}>Step id {step.stepId}</div>
      <SubSection
        title="1. On this device: perception and redaction"
        summary={blocked ? `held back: ${step.guardBlock!.rule}` : payload ? `${payload.redactions.length} redaction(s)` : 'in progress'}
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
            Nothing was sent: the guard held this step back ({step.guardBlock!.rule}
            {step.guardBlock!.entity ? `, ${step.guardBlock!.entity}` : ''}).
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
                Redacted screenshot: {Math.round(payload.image.region[2])}×{Math.round(payload.image.region[3])} CSS px at scale {payload.image.scale.toFixed(2)}, {payload.image.data === '' ? 'WebP not kept (dropped to fit the saved task when the panel was closed)' : `WebP ${base64Kb(payload.image.data)} KB`}
              </div>
            ) : (
              <div style={{ color: C.secondary }}>No screenshot this step (text only).</div>
            )}
            {showRawPayload && <PayloadViewer payload={payload} />}
          </div>
        )}
      </SubSection>

      <SubSection
        title="3. Model reply"
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
        {rejected && <div style={{ color: C.error, fontWeight: 500 }}>The extension's validator refused the plan ({rejected.reason}); nothing was executed.</div>}
        {plan && (
          <>
            <div style={{ color: C.secondary, marginBottom: 2 }}>The model planned {plan.actions.length} operation(s), validated on this device:</div>
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
          <TextBox key={i} label={m.label} text={m.text} />
        ))}
        {!plan && !rejected && step.serverNotes.length === 0 && <div style={{ color: C.secondary }}>{blocked ? 'The server was not asked.' : 'No reply yet.'}</div>}
      </SubSection>

      <SubSection title="4. Executed on this page" summary={plan ? `${executed} of ${plan.actions.length} executed${t ? ` · ${ms(t.act)}` : ''}` : 'nothing to run'} open={isLast}>
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

      <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 10, color: C.secondary, fontSize: T.xs, marginTop: 8, paddingTop: 6, borderTop: `1px solid ${C.border}` }}>
        <span style={{ fontWeight: 600 }}>Timings</span>
        {STAGES.map((k) => (
          <span key={k}>
            {k} <span style={{ color: C.body }}>{ms(t?.[k])}</span>
          </span>
        ))}
      </div>
    </Section>
  );
}

/** The answer to the task (the model's last report), or why the task stopped. `stopMessage`: the
 * panel's own explanation of the stop, when it has one (what the user can do about it). */
export function ResultCard({ log, stopMessage }: { log: RunLog; stopMessage?: string | null }) {
  if (!log.result) return null;
  const reports = log.steps.flatMap((s) => s.modelTexts).filter((m) => m.label.startsWith('Report') || m.label === 'Question for you');
  const lastReport = reports.at(-1);
  const earlierReports = reports.slice(0, -1);
  const done = log.result.kind === 'done';
  const modelStop = log.steps.flatMap((s) => s.modelTexts).filter((m) => m.label === 'Stopped by the model').at(-1);
  const stop = done ? null : describeError(stopMessage ?? log.result.text);
  const color = done ? C.ok : C.error;
  const bg = done ? C.okBg : C.errorBg;

  return (
    <section data-testid="run-result" style={{ ...S.card, padding: '12px 14px', borderColor: done ? C.okBorder : C.errorBorder }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 22, height: 22, borderRadius: '50%', background: bg, color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          {done ? <IconCheck size={13} /> : <IconAlert size={13} />}
        </span>
        <span style={{ fontSize: T.sm, fontWeight: 600, color }}>{done ? 'Result' : 'Stopped'}</span>
        {stop?.code && <code style={{ marginLeft: 'auto', fontSize: 10, color: C.secondary }}>{stop.code}</code>}
      </div>

      {done ? (
        <>
          <div style={{ fontSize: T.md, color: C.strong, lineHeight: 1.5, marginTop: 8, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {withBold(lastReport?.text || log.result.text)}
          </div>
          {lastReport && log.result.text && log.result.text !== lastReport.text && (
            <div style={{ fontSize: T.xs, color: C.secondary, marginTop: 8, paddingTop: 8, borderTop: `1px solid ${C.border}` }}>Summary: {withBold(log.result.text)}</div>
          )}
        </>
      ) : (
        <div style={{ marginTop: 6, fontSize: T.sm, lineHeight: 1.5 }}>
          <div style={{ fontWeight: 600, color: C.strong }}>{stop!.title}</div>
          {stop!.body && <div style={{ color: C.body, overflowWrap: 'anywhere' }}>{stop!.body}</div>}
          {modelStop?.text && <div style={{ color: C.body, marginTop: 6, whiteSpace: 'pre-wrap' }}>{withBold(modelStop.text)}</div>}
          {lastReport && (
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${C.border}` }}>
              <div style={{ fontSize: T.xs, color: C.secondary, marginBottom: 2 }}>{lastReport.label === 'Question for you' ? 'Question for you' : 'Found before it stopped'}</div>
              <div style={{ color: C.strong, whiteSpace: 'pre-wrap' }}>{withBold(lastReport.text)}</div>
            </div>
          )}
        </div>
      )}

      {earlierReports.length > 0 && (
        <details style={{ marginTop: 8, fontSize: T.xs, color: C.secondary }}>
          <summary class="ag-sub" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <IconChevron size={12} />
            {earlierReports.length} earlier finding(s)
          </summary>
          {earlierReports.map((r, i) => (
            <TextBox key={i} label={r.label} text={r.text} />
          ))}
        </details>
      )}
    </section>
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
  const problems = loadFailures.length + workerProblems.length;

  return (
    <details data-testid="run-log" style={{ ...S.card, overflow: 'hidden' }}>
      <summary class="ag-sec" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', fontSize: T.sm }}>
        <span style={{ color: C.muted }}>
          <IconChevron size={13} />
        </span>
        <span style={{ fontWeight: 600, color: C.strong, flex: 1 }}>Activity log</span>
        {problems > 0 && <span style={S.tag(C.error, C.errorBg)}>{problems} problem(s)</span>}
        <span style={{ fontSize: T.xs, color: C.secondary }}>
          {log.steps.length} step{log.steps.length === 1 ? '' : 's'} · technical details
        </span>
      </summary>

      <Section testId="run-setup" title="Setup" summary={`${log.setup.length} event(s)`}>
        <ol style={{ margin: 0, paddingLeft: 16, color: C.body, fontSize: T.xs }}>
          {log.setup.map((line, i) => (
            <li key={i} style={{ margin: '2px 0' }}>
              {line}
            </li>
          ))}
        </ol>
        {loadFailures.length > 0 && <div style={{ color: C.error, marginTop: 4, fontWeight: 500 }}>Models failed to load: {loadFailures.map((f) => `${f.role} (${f.code})`).join(', ')}</div>}
        {workerProblems.length > 0 && (
          <div style={{ color: C.error, marginTop: 4, fontWeight: 500 }}>Perception worker: {workerProblems.map((p) => describeWorkerProblem(p)).join(', ')}</div>
        )}
      </Section>

      {log.steps.map((step, i) => (
        <StepSection key={step.stepId} step={step} index={i} isLast={i === log.steps.length - 1} running={running} showRawPayload={showRawPayload} />
      ))}
    </details>
  );
}

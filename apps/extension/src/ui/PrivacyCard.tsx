// What left this device on the latest step, and whether it was protected: a one-line verdict, the
// redaction breakdown, and the per-item un-redact control. The verdict is derived from the step's
// own evidence (the guarded payload, a guard block, why the screenshot was not used); it never
// says "protected" for a step whose checks did not complete.

import type { SanitizedContext } from '@aegis/protocol';
import type { ProtectedField } from '../host/session';
import type { StepLog } from './RunLog';
import { RedactionSummary } from './RedactionSummary';
import { UnredactPanel } from './UnredactPanel';
import { summarizePerception } from './PerceptionStatus';
import { IconAlert, IconChevron, IconShield } from './icons';
import { C, S, T } from './design';

type Verdict = { tone: 'ok' | 'warn' | 'error'; title: string; detail?: string };

export function privacyVerdict(payload: SanitizedContext | null, latest: StepLog | undefined): Verdict | null {
  if (latest?.guardBlock && !latest.payload) {
    return {
      tone: 'error',
      title: 'Held back: nothing was sent',
      detail: `The privacy guard held back the latest step (${latest.guardBlock.rule}${latest.guardBlock.entity ? `, ${latest.guardBlock.entity}` : ''}).`,
    };
  }
  if (!payload) return null;
  const n = payload.redactions.length;
  const hidden = n === 0 ? 'nothing private was found' : `${n} item${n === 1 ? '' : 's'} hidden before sending`;
  const perception = latest?.perception && latest.stepId === payload.step_id ? latest.perception : undefined;
  if (!payload.image) {
    if (perception?.capture === 'not-needed') return { tone: 'ok', title: `Protected, text only: ${hidden}`, detail: 'No screenshot was needed: nothing on screen is a picture.' };
    const why = perception ? summarizePerception(perception, payload.redactions).reason : undefined;
    return { tone: 'warn', title: `Protected, text only: ${hidden}`, detail: `No screenshot was sent${why ? `: ${why}` : ''}.` };
  }
  const grey = Math.round(payload.coverage.unanalysed * 100);
  return {
    tone: 'ok',
    title: `Protected: ${hidden}`,
    detail: `Checked on this device before it was sent.${grey > 0 ? ` ${grey}% of the screenshot could not be checked in time and was greyed out.` : ''}`,
  };
}

const TONE = {
  ok: { color: C.ok, bg: C.okBg },
  warn: { color: C.warn, bg: C.warnBg },
  error: { color: C.error, bg: C.errorBg },
};

export interface PrivacyCardProps {
  payload: SanitizedContext | null;
  protectedFields: ProtectedField[];
  latest: StepLog | undefined;
  onUnredact(ref: string, reason: string): void;
}

export function PrivacyCard({ payload, protectedFields, latest, onUnredact }: PrivacyCardProps) {
  const verdict = privacyVerdict(payload, latest);
  if (!verdict) return null;
  const tone = TONE[verdict.tone];
  return (
    <details data-testid="run-redactions" style={{ ...S.card, overflow: 'hidden' }}>
      <summary class="ag-sec" style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '11px 12px 11px 14px' }}>
        <span style={{ width: 28, height: 28, borderRadius: 8, background: tone.bg, color: tone.color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          {verdict.tone === 'error' ? <IconAlert size={15} /> : <IconShield size={15} />}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={S.eyebrow}>Privacy</span>
          </div>
          <div style={{ fontSize: T.sm, fontWeight: 600, color: verdict.tone === 'ok' ? C.strong : tone.color, marginTop: 1 }}>{verdict.title}</div>
          {verdict.detail && <div style={{ fontSize: T.xs, color: C.secondary, marginTop: 1 }}>{verdict.detail}</div>}
        </div>
        <span style={{ color: C.muted, marginTop: 6 }}>
          <IconChevron size={14} />
        </span>
      </summary>
      {payload && (
        <div style={{ padding: '12px 14px' }}>
          <RedactionSummary redactions={payload.redactions} coverage={payload.coverage} protectedFields={protectedFields} />
          <UnredactPanel redactions={payload.redactions} onUnredact={onUnredact} />
        </div>
      )}
    </details>
  );
}

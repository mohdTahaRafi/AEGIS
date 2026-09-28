// Per-step evidence of which perception channels actually ran and which ones produced the
// redactions in the payload — derived only from the worker's real counters and the payload's own
// `redactions[].sources`, never from configuration or intent.

import type { SanitizedContext } from '@aegis/protocol';
import { PERCEPTION_DEADLINE_MS, type PerceptionStepStatus } from '../host/perception-client/run-step';
import type { WorkerProblem } from '../host/perception-client/client';
import type { ModelLoadFailure, PerceiveDiagnostics } from '../shared/worker-protocol';

export type SourceChannel = 'dom' | 'text' | 'ocr' | 'vision';

export function channelOfSource(source: string): SourceChannel {
  if (source.startsWith('vision:')) return 'vision';
  if (source.startsWith('ocr:')) return 'ocr';
  if (source.startsWith('dom:')) return 'dom';
  return 'text';
}

export function redactionsByChannel(redactions: SanitizedContext['redactions']): Record<SourceChannel, number> {
  const counts: Record<SourceChannel, number> = { dom: 0, text: 0, ocr: 0, vision: 0 };
  for (const r of redactions) {
    const channels = new Set(r.sources.map(channelOfSource));
    for (const c of channels) counts[c] += 1;
  }
  return counts;
}

const CAPTURE_REASON: Record<Exclude<PerceptionStepStatus['capture'], 'ok'>, string> = {
  'not-needed': 'no image/canvas/video on screen and DOM coverage is high, so no capture was needed',
  'geometry-changed': 'the page moved during capture, so the frame was discarded',
  disabled: 'the image path is disabled',
  permission: "Chrome refused the screenshot: AEGIS has not been invoked on this tab (activeTab not granted) - click the AEGIS toolbar icon while this tab is in front",
  'grant-lost-navigation': 'Chrome withdrew screenshot access because this tab moved to a different site after AEGIS was invoked on it - click the AEGIS toolbar icon again on this page',
  'host-access': 'Chrome refused the screenshot: AEGIS has no access to this site - click the AEGIS toolbar icon while this tab is in front',
  'origin-changed': "the task's tab is now on a different site than the task started on, so it was not captured",
  'restricted-page': 'Chrome does not allow extensions to capture this page type',
  throttled: 'Chrome capture rate limit hit',
  'no-tab': 'no capturable tab/window',
  'not-visible': "the task's tab was not in front when capturing, so no frame was taken - keep that tab visible while the task runs",
  decode: 'the captured image could not be decoded',
  unknown: 'screenshot failed for an unrecognised reason',
};

export interface PerceptionSummary {
  mode: string;
  reason?: string;
  modelsRan: { clip: number; face: number; ocrDet: number; ocrRec: number };
  crops?: { requested: number; analysed: number; deadline: number; budget: number; noCapability: number };
}

/** "Vision" in the mode label means a model genuinely produced a redaction this step; a model that
 * ran but found nothing is still listed under `modelsRan`, so the two are never conflated. */
export function summarizePerception(status: PerceptionStepStatus, redactions: SanitizedContext['redactions']): PerceptionSummary {
  const d = status.diagnostics;
  const modelsRan = {
    clip: d ? d.inferences.vitRegion + d.inferences.vitFullFrame : 0,
    face: d?.inferences.face ?? 0,
    ocrDet: d?.inferences.ocrDet ?? 0,
    ocrRec: d?.inferences.ocrRec ?? 0,
  };
  const byChannel = redactionsByChannel(redactions);
  const visionSources = new Set(redactions.flatMap((r) => r.sources).filter((s) => s.startsWith('vision:')));

  let reason: string | undefined;
  if (status.capture !== 'ok') {
    reason = status.capture === 'disabled' && status.disabledReason ? `${CAPTURE_REASON.disabled} (${status.disabledReason})` : CAPTURE_REASON[status.capture];
    if (status.captureDetail) reason += ` [Chrome: ${status.captureDetail}]`;
  } else if (status.worker === 'failed') {
    reason = 'the perception worker failed during this step - no image was sent';
  }

  const parts: string[] = [];
  if (byChannel.dom + byChannel.text > 0 || (byChannel.ocr === 0 && byChannel.vision === 0)) parts.push('DOM');
  if (byChannel.ocr > 0) parts.push('OCR');
  if (visionSources.has('vision:face')) parts.push('face detection');
  if ([...visionSources].some((s) => s !== 'vision:face')) parts.push('vision/CLIP');
  const ranAnything = modelsRan.clip + modelsRan.face + modelsRan.ocrDet > 0;
  // What the models themselves reported, independent of any payload: a step the guard blocked has
  // no payload at all, and must not read as "found nothing" when YuNet/CLIP/OCR did find something.
  const findings = new Set<string>();
  for (const r of d?.regions ?? []) {
    if ((r.faces ?? 0) > 0) findings.add('face');
    if (r.vit?.accepted && r.vit.entity) findings.add(r.vit.entity);
    for (const e of r.ocrEntities ?? []) findings.add(`OCR ${e}`);
  }
  const domOnly = parts.length === 1 && parts[0] === 'DOM';
  const mode = !domOnly
    ? parts.join(' + ')
    : findings.size > 0
      ? `vision detected ${[...findings].join(', ')} (not in a sent payload this step)`
      : ranAnything
        ? 'DOM-only result (vision ran, found nothing)'
        : 'DOM-only';

  const crops = d
    ? {
        requested: status.regionsRequested,
        analysed: d.regions.filter((r) => r.outcome === 'analysed').length,
        deadline: d.regions.filter((r) => r.outcome === 'deadline').length,
        budget: d.regions.filter((r) => r.outcome === 'budget').length,
        noCapability: d.regions.filter((r) => r.outcome === 'no-capability').length,
      }
    : undefined;

  return { mode, reason, modelsRan, crops };
}

/** "YuNet wasm · CLIP wasm · OCR webgpu" — where each model actually ran this step. */
export function describeProviders(providers: PerceiveDiagnostics['providers']): string {
  const parts: string[] = [];
  if (providers.face) parts.push(`YuNet ${providers.face}`);
  if (providers.vit) parts.push(`CLIP ${providers.vit}`);
  if (providers.ocrDet) parts.push(providers.ocrRec && providers.ocrRec !== providers.ocrDet ? `OCR det ${providers.ocrDet} / rec ${providers.ocrRec}` : `OCR ${providers.ocrDet}`);
  return parts.join(' · ');
}

export interface PerceptionStatusProps {
  stepId: string;
  status: PerceptionStepStatus;
  redactions: SanitizedContext['redactions'];
  loadFailures: ModelLoadFailure[];
  workerProblems: WorkerProblem[];
}

export function PerceptionStatus({ stepId, status, redactions, loadFailures, workerProblems }: PerceptionStatusProps) {
  const summary = summarizePerception(status, redactions);
  const byChannel = redactionsByChannel(redactions);
  const d = status.diagnostics;
  const muted = { color: '#555', margin: '2px 0' };
  return (
    <div data-testid="perception-status" style={{ fontSize: 12, padding: '4px 0', borderBottom: '1px solid #eee' }}>
      <div>
        <strong>Perception ({stepId}):</strong> <span data-testid="perception-mode">{summary.mode}</span>
      </div>
      {summary.reason && (
        <div data-testid="perception-reason" style={{ color: status.capture === 'not-needed' ? '#555' : '#b00', margin: '2px 0' }}>
          Vision not used: {summary.reason}
        </div>
      )}
      {d && (
        <div style={muted}>
          ran: CLIP ×{summary.modelsRan.clip} · YuNet ×{summary.modelsRan.face} · OCR det ×{summary.modelsRan.ocrDet} / rec ×{summary.modelsRan.ocrRec} · {describeProviders(d.providers) || d.backend} · {Math.round(d.ms.total)} ms
        </div>
      )}
      {summary.crops && (
        <div style={muted}>
          crops: {summary.crops.analysed}/{summary.crops.requested} analysed
          {summary.crops.deadline > 0 && ` · ${summary.crops.deadline} past ${PERCEPTION_DEADLINE_MS} ms deadline (left grey)`}
          {summary.crops.budget > 0 && ` · ${summary.crops.budget} over crop budget (left grey)`}
          {summary.crops.noCapability > 0 && ` · ${summary.crops.noCapability} with no model available`}
        </div>
      )}
      <div style={muted}>
        redactions by source: DOM {byChannel.dom} · text {byChannel.text} · OCR {byChannel.ocr} · vision {byChannel.vision}
      </div>
      {d?.regions
        .filter((r) => r.outcome === 'analysed')
        .map((r) => (
          <div key={r.regionId} style={{ ...muted, paddingLeft: 8 }}>
            {r.regionId}: {r.vit ? `CLIP "${r.vit.label}" ${r.vit.score.toFixed(2)}${r.vit.entity && r.vit.entityScore !== undefined ? ` · ${r.vit.entity} ${r.vit.entityScore.toFixed(2)}` : ''}${r.vit.accepted ? ' (redacted)' : ''}` : 'CLIP not run'}
            {r.faces !== undefined && ` · faces ${r.faces}${r.faceTopScore !== undefined ? ` (${r.faceTopScore.toFixed(2)})` : ''}`}
            {r.ocrLinesDetected !== undefined && ` · OCR ${r.ocrLinesDetected} lines${r.ocrEntities && r.ocrEntities.length > 0 ? ` → ${r.ocrEntities.join(', ')}` : ''}`}
            {r.ms !== undefined && ` · ${Math.round(r.ms)} ms`}
          </div>
        ))}
      {d && d.modelErrors.length > 0 && <div style={{ color: '#b00' }}>model errors this step: {d.modelErrors.map((e) => `${e.role} ${e.code}`).join(', ')}</div>}
      {loadFailures.length > 0 && <div style={{ color: '#b00' }}>models failed to load: {loadFailures.map((f) => `${f.role} (${f.code})`).join(', ')}</div>}
      {workerProblems.length > 0 && (
        <div style={{ color: '#b00' }}>perception worker: {workerProblems.map((p) => (p.kind === 'crashed' ? 'crashed' : `error ${p.code}`)).join(', ')}</div>
      )}
    </div>
  );
}

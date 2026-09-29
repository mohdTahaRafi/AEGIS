// One step of the local privacy pipeline, stage by stage, in the order the code runs them
// (session.ts `runStep`: observe → perceive → sanitize → guard → send; worker.ts: per crop,
// YuNet → OCR → CLIP, then the whole-screen CLIP label), each with what it found and what that
// became in the payload. Built only from what the step actually produced: the worker's own
// diagnostics, the sent payload's `redactions[].sources`, the protected-field list and the stage
// timings. Shows entity types, placeholders, element ids and field labels as sent; never a value.

import type { SanitizedContext } from '@aegis/protocol';
import type { PerceptionStepStatus } from '../host/perception-client/run-step';
import type { ProtectedField, StepStageTimings } from '../host/session';
import { SENT_AS } from './RedactionSummary';

type Redaction = SanitizedContext['redactions'][number];

export type StageStatus = 'done' | 'skipped' | 'pending' | 'blocked';

export interface TraceStage {
  title: string;
  ms?: number;
  status: StageStatus;
  lines: string[];
}

export interface PipelineTraceInput {
  status: PerceptionStepStatus;
  /** The payload of THIS step, or null while it is still being built / when the guard blocked it. */
  payload: SanitizedContext | null;
  protectedFields: ProtectedField[];
  timings?: StepStageTimings;
  guardBlock: { rule: string; entity?: string } | null;
  /** Stop after the guard (the run log shows the network part in its own sections). */
  localOnly?: boolean;
}

/** What a redaction source means, in words: which stage produced it. */
export function describeSource(source: string): string {
  const [kind, detail = ''] = source.split(':', 2);
  const name = detail.replace(/_/g, ' ');
  switch (kind) {
    case 'dom':
      return 'field label';
    case 'pattern':
      return `${name} pattern`;
    case 'label':
      return '"Label: value" text';
    case 'ocr':
      return 'OCR text';
    case 'ner':
      return 'NER model';
    case 'vision':
      if (detail === 'face') return 'YuNet face';
      if (detail.startsWith('qr-') || detail.startsWith('barcode')) return 'QR/barcode structure check';
      if (detail.startsWith('clip+') || detail.startsWith('id-text')) return `CLIP confirmed by ${detail.replace(/^clip\+/, '').replace(/[-+]/g, ' ')}`;
      return 'CLIP';
    default:
      return source;
  }
}

function describeRedaction(r: Redaction): string {
  const fromPixels = r.sources.some((s) => s.startsWith('vision:') || s.startsWith('ocr:'));
  const what = r.ref ? `${r.entity} ${r.ref}` : `${r.entity} (${fromPixels ? 'image region' : 'masked, no value read'})`;
  const boxes = r.boxes.length > 1 ? ` · ${r.boxes.length} places` : '';
  return `${what} ← ${[...new Set(r.sources.map(describeSource))].join(' + ')}${boxes}`;
}

function redactionsFrom(payload: SanitizedContext | null, match: (source: string) => boolean): Redaction[] {
  return (payload?.redactions ?? []).filter((r) => r.sources.some(match));
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function buildPipelineTrace({ status, payload, protectedFields, timings, guardBlock, localOnly = false }: PipelineTraceInput): TraceStage[] {
  const d = status.diagnostics;
  const regions = d?.regions ?? [];
  const analysed = regions.filter((r) => r.outcome === 'analysed');
  const fresh = analysed.filter((r) => !r.cached);
  const cached = analysed.filter((r) => r.cached);
  const workerRan = status.capture === 'ok' && status.worker === 'ok' && !!d;
  const stages: TraceStage[] = [];

  // 1. Content script: the DOM snapshot and the value-independent field semantics.
  const domLines: string[] = [];
  if (payload) domLines.push(`${payload.nodes.length} elements and ${payload.text.length} text runs read`);
  if (protectedFields.length > 0) {
    domLines.push('sensitive fields, by their label (value never needed):');
    for (const f of protectedFields) domLines.push(`  ${f.entity} "${f.label.slice(0, 40)}" → ${f.ref ?? SENT_AS[f.sent]}`);
  } else if (payload) {
    domLines.push('no field labelled as sensitive');
  }
  stages.push({ title: 'DOM read (content script)', ms: timings?.observe, status: payload ? 'done' : 'pending', lines: domLines });

  // 2. Screenshot and the crops chosen for the models.
  if (status.capture === 'ok') {
    const lines = [`${status.regionsRequested} picture region(s) chosen for the vision models`];
    if (timings) lines.push(`capture + all vision models below: ${Math.round(timings.perceive)} ms`);
    if (cached.length > 0) lines.push(`${cached.length} unchanged since an earlier step: earlier result reused, models not re-run`);
    const pixelChecked = regions.filter((r) => r.outcome === 'pixels');
    if (pixelChecked.length > 0) lines.push(`${pixelChecked.length} past CLIP's budget: cleared by pixel checks (no QR/barcode/signature ink, no document text)`);
    const grey = regions.filter((r) => r.outcome !== 'analysed' && r.outcome !== 'pixels');
    if (grey.length > 0) lines.push(`${grey.length} not analysed (${[...new Set(grey.map((r) => r.outcome))].join(', ')}): left grey`);
    if (status.worker === 'failed') lines.push('perception worker failed: no image sent');
    stages.push({ title: 'Screenshot', status: 'done', lines });
  } else {
    stages.push({ title: 'Screenshot', status: 'skipped', lines: [`not taken: ${status.capture}${status.disabledReason ? ` (${status.disabledReason})` : ''}`] });
  }

  // 3-5. Worker, per crop in this order. Times are totals over all crops.
  if (workerRan) {
    const reusedNote = cached.length > 0 ? `, ${cached.length} reused from an earlier step` : '';
    const tag = (r: (typeof analysed)[number]) => `${r.regionId}${r.cached ? ' (reused)' : ''}`;
    const faceRegions = analysed.filter((r) => (r.faces ?? 0) > 0);
    const faceRedactions = redactionsFrom(payload, (s) => s === 'vision:face');
    const f = d.frame;
    stages.push({
      title: `Face detection: YuNet (${d.providers.face ?? 'not loaded'})`,
      ms: d.ms.face,
      status: d.providers.face ? 'done' : 'skipped',
      lines: [
        f ? `whole screen: ${f.facePasses} pass(es) (full frame + native-resolution tiles), ${f.faces} face(s) passing the landmark check` : `ran on ${d.inferences.face} crop(s)${reusedNote}`,
        ...(faceRegions.length > 0
          ? faceRegions.map((r) => `${tag(r)}: ${r.faces} face(s), top score ${r.faceTopScore?.toFixed(2) ?? '?'}`)
          : ['no faces found']),
        ...faceRedactions.map((r) => `redacted: ${describeRedaction(r)}`),
      ],
    });

    const ocrRegions = analysed.filter((r) => (r.ocrEntities?.length ?? 0) > 0);
    const linesFound = fresh.reduce((n, r) => n + (r.ocrLinesDetected ?? 0), 0);
    const ocrRedactions = redactionsFrom(payload, (s) => s.startsWith('ocr:'));
    stages.push({
      title: `Text in pictures: PP-OCR (${d.providers.ocrDet ?? 'not loaded'})`,
      ms: d.ms.ocr,
      status: d.providers.ocrDet ? 'done' : 'skipped',
      lines: [
        f
          ? `whole screen: ${f.linesDetected} text line(s) found; ${f.linesDomCovered} already read from the page's DOM; ${f.linesRecognized} read by OCR (pictures, canvas, frames)${f.linesUnread > 0 ? `; ${f.linesUnread} not read in time: grey` : ''}`
          : `detector ran on ${d.inferences.ocrDet} crop(s)${reusedNote}, ${linesFound} text line(s) found, ${d.inferences.ocrRec} read, then checked by the text recognisers`,
        ...(ocrRegions.length > 0
          ? ocrRegions.map((r) => `${tag(r)}: ${r.ocrEntities!.join(', ')}`)
          : ['no sensitive text in pictures']),
        ...ocrRedactions.map((r) => `redacted: ${describeRedaction(r)}`),
      ],
    });

    const clipLines = fresh.map((r) => {
      if (!r.vit) return `${r.regionId}: not classified`;
      const guess = `looks like "${r.vit.label}" (${r.vit.score.toFixed(2)})`;
      const entity = r.vit.entity && r.vit.entityScore !== undefined ? `${r.vit.entity} ${r.vit.entityScore.toFixed(2)}` : null;
      const verdict = r.vit.accepted ? `→ ${entity} ✓ redacted${r.vit.why ? ` (${r.vit.why})` : ''}` : entity ? `→ ${entity} not confirmed by the pixels: not redacted` : '→ nothing sensitive';
      return `${r.regionId}: ${guess} ${verdict}`;
    });
    for (const r of cached) {
      if (r.vit) clipLines.push(`${r.regionId}: (reused) "${r.vit.label}"${r.vit.accepted ? ` → ${r.vit.entity} ✓ redacted` : ''}`);
    }
    stages.push({
      title: `Picture classification: CLIP ViT (${d.providers.vit ?? 'not loaded'})`,
      ms: d.ms.vit,
      status: d.providers.vit ? 'done' : 'skipped',
      lines: clipLines.length > 0 ? clipLines : ['no crops to classify'],
    });

    if (d.inferences.vitFullFrame > 0) {
      stages.push({ title: 'Whole-screen label: CLIP', ms: d.ms.screenLabel, status: 'done', lines: ['one low-resolution pass over the full frame (screen state, not a redaction)'] });
    }
  } else {
    stages.push({ title: 'Vision models: YuNet · PP-OCR · CLIP', status: 'skipped', lines: ['not run this step (no screenshot)'] });
  }

  // 6. Sanitize: text recognisers over DOM text and field values, then fusion of every stage.
  if (payload) {
    const textRedactions = redactionsFrom(payload, (s) => s.startsWith('pattern:') || s.startsWith('label:') || s.startsWith('ner:') || s.startsWith('dom:'));
    const counts: Record<string, number> = {};
    for (const r of payload.redactions) counts[r.entity] = (counts[r.entity] ?? 0) + 1;
    stages.push({
      title: 'Text recognisers + merge (sanitize)',
      ms: timings?.sanitize,
      status: 'done',
      lines: [
        ...(textRedactions.length > 0 ? textRedactions.map((r) => `redacted: ${describeRedaction(r)}`) : ['no sensitive text in the DOM']),
        `after merging all stages: ${payload.redactions.length} redaction(s)${payload.redactions.length > 0 ? ` (${Object.entries(counts).map(([e, n]) => `${e} ${n}`).join(' · ')})` : ''}`,
      ],
    });
    stages.push({
      title: 'Screenshot redaction (compositor)',
      status: payload.image ? 'done' : 'skipped',
      lines: payload.image
        ? [`cleared ${pct(payload.coverage.cleared)} · redacted ${pct(payload.coverage.redacted)} · grey (unanalysed) ${pct(payload.coverage.unanalysed)}`]
        : ['no image in this step: text only'],
    });
  } else {
    stages.push({ title: 'Text recognisers + merge (sanitize)', ms: timings?.sanitize, status: guardBlock ? 'done' : 'pending', lines: [] });
  }

  // 7. Guard, the last local check; then the network.
  if (guardBlock && !payload) {
    stages.push({ title: 'Guard', ms: timings?.guard, status: 'blocked', lines: [`BLOCKED: ${guardBlock.rule}${guardBlock.entity ? ` (${guardBlock.entity})` : ''}. Nothing was sent`] });
    return stages;
  }
  stages.push({
    title: 'Guard',
    ms: timings?.guard,
    status: payload ? 'done' : 'pending',
    lines: payload ? [`passed: schema · id shapes · vault-value sweep · pattern re-sweep${payload.image ? ' · image re-scan' : ''}`] : [],
  });
  if (localOnly) return stages;
  stages.push({
    title: 'Sent to gateway → VLM',
    ms: timings?.server,
    status: timings ? 'done' : 'pending',
    lines: payload ? [timings ? 'plan received (see Activity)' : 'sent, waiting for the plan'] : [],
  });
  return stages;
}

const MARK: Record<StageStatus, { mark: string; color: string }> = {
  done: { mark: '✓', color: '#070' },
  skipped: { mark: '–', color: '#777' },
  pending: { mark: '…', color: '#777' },
  blocked: { mark: '✗', color: '#b00' },
};

export function PipelineTrace(props: PipelineTraceInput) {
  const stages = buildPipelineTrace(props);
  return (
    <div data-testid="pipeline-trace" style={{ margin: '4px 0' }}>
      <div style={{ color: '#555' }}>Run order this step (faces and text over the whole screenshot, then CLIP on each picture; times are totals):</div>
      <ol style={{ margin: '2px 0', paddingLeft: 18 }}>
        {stages.map((s, i) => (
          <li key={i} data-status={s.status} style={{ margin: '3px 0' }}>
            <span style={{ color: MARK[s.status].color }}>{MARK[s.status].mark}</span> <strong>{s.title}</strong>
            {s.ms !== undefined && <span style={{ color: '#555' }}> · {Math.round(s.ms)} ms</span>}
            {s.lines.map((line, j) => (
              <div key={j} style={{ color: line.startsWith('redacted:') || line.includes('✓ redacted') ? '#700' : '#555', paddingLeft: 8, whiteSpace: 'pre-wrap' }}>
                {line}
              </div>
            ))}
          </li>
        ))}
      </ol>
    </div>
  );
}

// design.md §11's per-step orchestration glue: capture → geometry-digest check → `perceive` →
// map candidates into fusion's shape → (after `buildSanitizedContext` runs) attach the composed
// image. Factored out of `session.ts` so that file's step loop doesn't have to inline the whole
// capture/escalation/compose dance — this is the one place all of it is wired together.

import type { Candidate } from '../privacy/types';
import type { AblationArm } from '../../shared/ablation';
import type { Box, PerceiveDiagnostics } from '../../shared/worker-protocol';
import type { WireScreenNode } from '../../shared/messages';
import type { PerceptionClient } from './client';
import { decideEscalation, type PayloadLevel } from '../privacy/context/escalation';
import { structuralCoverage } from '../privacy/context/structural-coverage';
import { computeGeometryDigest, GeometryDigestGuard } from '../capture/digest';
import type { CaptureFailureReason, CaptureResult } from '../capture/classify';

// Per-step vision time budget: once it elapses no further crop is started (the one in flight
// finishes) and every crop still queued stays grey — unanalysed, never cleared. Was 120 ms, which is
// shorter than a single crop takes (measured on WASM, 2026-09-28: YuNet ~31 ms + CLIP ~92 ms + OCR
// det ~130-180 ms + OCR rec ~30 ms per text line, i.e. ~0.25-1.3 s per crop), so exactly one image
// per step was ever analysed and every other image on the page was sent grey. 1500 ms fits ~3-6
// typical crops on WASM (the crop budget still caps it at 8/16), adds at most ~1.5 s + one crop to a
// step whose model round trip already takes seconds, and keeps the worst case bounded.
export const PERCEPTION_DEADLINE_MS = 1500;
const IMAGE_LONG_SIDE_MAX_PX = 1600;

export interface CaptureFn {
  (): Promise<CaptureResult>;
}

/** Why this step did or did not get vision — every exit path of `runPerceptionStep` sets one, so
 * "DOM-only" is always attributable to a concrete reason rather than inferred from silence. */
export interface PerceptionStepStatus {
  /** `disabled`: the session never called `runPerceptionStep` this step (see `disabledReason`). */
  capture: 'ok' | 'not-needed' | 'geometry-changed' | 'disabled' | CaptureFailureReason;
  disabledReason?: 'hostile-dynamic' | 'dom_only';
  /** Chrome's own error text for a failed capture (quoted URLs removed) — shown in the panel so a
   * failure is never reduced to a reason code alone. Panel/ledger only; never in the payload. */
  captureDetail?: string;
  worker: 'ok' | 'failed' | 'not-called';
  level: PayloadLevel;
  /** Crop regions (vision nodes) this step wanted analysed. */
  regionsRequested: number;
  diagnostics?: PerceiveDiagnostics;
}

export interface PerceptionStepDeps {
  client: PerceptionClient;
  capture: CaptureFn;
  digestGuard: GeometryDigestGuard;
  /** Re-reads node boxes for the digest's post-capture check — the caller passes its own
   * `requestGraph`-equivalent so this module never talks to the content port directly. */
  reobserveGeometry: () => Promise<WireScreenNode[]>;
  viewport: { w: number; h: number };
  /** T-6.9: `'pixel_only'` forces one whole-viewport crop region regardless of DOM structure
   * (design.md §18.3: "ignore Channel D and DOM text; OCR the full frame") — every other arm
   * (including `undefined`, the release default) leaves this function's normal DOM-node-driven
   * region selection untouched. */
  ablation?: AblationArm;
}

export interface PerceptionStepResult {
  visionCandidates: Candidate[];
  level: PayloadLevel;
  captured: boolean;
  captureInconsistent: boolean;
  screenLabel?: { label: string; score: number };
  /** Node ids whose vision analysis actually completed this step (not `timedOut`) — feeds
   * `attach-image.ts`'s clearance decision. Only meaningful when `captured` is true. */
  visionAnalyzedNodeIds: Set<string>;
  /** design.md §11.1's image scale — the long side capped at 1600px (phase_4_vision.md §7.3).
   * Exposed so `session.ts` can pass the same number to both `attachImage`'s `compose` call and
   * the geometry the resulting `image.scale` field records. */
  scale: number;
  status: PerceptionStepStatus;
}

function isVisionNode(node: WireScreenNode): boolean {
  return node.role === 'img';
}

/** Area of `box` inside the viewport — what a screenshot crop of it can actually contain. */
function visibleArea([x, y, w, h]: readonly [number, number, number, number], viewport: { w: number; h: number }): number {
  const vw = Math.max(0, Math.min(x + w, viewport.w) - Math.max(x, 0));
  const vh = Math.max(0, Math.min(y + h, viewport.h) - Math.max(y, 0));
  return vw * vh;
}

/** Largest visible image first: the crop budget and deadline cut from the tail, so what gets
 * analysed is where the most pixels (and the most chance of a document, face or QR code) are,
 * rather than whatever came first in DOM order — typically header icons and logos. Anything cut
 * stays grey either way. */
export function prioritiseVisionNodes<T extends { box: readonly [number, number, number, number] }>(nodes: readonly T[], viewport: { w: number; h: number }): T[] {
  return [...nodes].sort((a, b) => visibleArea(b.box, viewport) - visibleArea(a.box, viewport));
}

function geometryBoxesOf(nodes: readonly WireScreenNode[]): { id: string; box: readonly [number, number, number, number] }[] {
  return nodes.map((n) => ({ id: n.id, box: n.box }));
}

export async function runPerceptionStep(nodes: readonly WireScreenNode[], deps: PerceptionStepDeps): Promise<PerceptionStepResult> {
  const pixelOnly = deps.ablation === 'pixel_only';
  const visionNodes = pixelOnly ? [] : nodes.filter(isVisionNode);
  const explainedFraction = structuralCoverage(
    nodes.map((n) => ({ box: n.box, requiresVision: isVisionNode(n) })),
    deps.viewport,
  );
  const decision = pixelOnly ? { level: 'L1' as const, fullFrame: true, region: null } : decideEscalation({ explainedFraction, serverRequestedRegion: null });

  const scale = Math.min(1, IMAGE_LONG_SIDE_MAX_PX / Math.max(deps.viewport.w, deps.viewport.h));
  const regionsRequested = pixelOnly ? 1 : visionNodes.length;
  const noVision = (status: Omit<PerceptionStepStatus, 'regionsRequested'>, captureInconsistent = false): PerceptionStepResult => ({
    visionCandidates: [],
    level: status.level,
    captured: false,
    captureInconsistent,
    visionAnalyzedNodeIds: new Set(),
    scale,
    status: { ...status, regionsRequested },
  });

  const noCaptureNeeded = !pixelOnly && decision.level === 'L0' && visionNodes.length === 0;
  if (noCaptureNeeded) {
    return noVision({ capture: 'not-needed', worker: 'not-called', level: decision.level });
  }

  const beforeDigest = await computeGeometryDigest(geometryBoxesOf(nodes));
  const captureResult = await deps.capture();
  if (!captureResult.ok) {
    return noVision({ capture: captureResult.reason, ...(captureResult.detail ? { captureDetail: captureResult.detail } : {}), worker: 'not-called', level: 'L0' });
  }
  const bitmap = captureResult.bitmap;

  const freshNodes = await deps.reobserveGeometry();
  const afterDigest = await computeGeometryDigest(geometryBoxesOf(freshNodes));
  const digestVerdict = deps.digestGuard.check(beforeDigest, afterDigest);
  if (digestVerdict !== 'ok') {
    bitmap.close();
    return noVision({ capture: 'geometry-changed', worker: 'not-called', level: 'L0' }, digestVerdict === 'degrade');
  }

  // T-6.9: pixel-only sends ONE whole-viewport region at `kind: 'crop'` (not `'full'`) so it goes
  // through `handlePerceive`'s real face+OCR loop — the `'full'` kind exists only for the
  // screen-state label today and is never OCR'd or face-detected (see `worker.ts`'s
  // `handlePerceive`), which would silently defeat "OCR the full frame." Reuses the literal id
  // `'full-frame'` so the existing `regionId !== 'full-frame' → nodeId` mapping below already
  // treats it as node-less, with no new special-casing needed there.
  const regions = pixelOnly
    ? [{ id: 'full-frame', box: [0, 0, deps.viewport.w, deps.viewport.h] as Box, kind: 'crop' as const }]
    : [
        ...prioritiseVisionNodes(visionNodes, deps.viewport).map((n) => ({ id: n.id, box: n.box as Box, kind: 'crop' as const })),
        ...(decision.fullFrame ? [{ id: 'full-frame', box: [0, 0, deps.viewport.w, deps.viewport.h] as Box, kind: 'full' as const }] : []),
      ];

  // `PerceptionClient`'s contract: a rejected job (worker crashed or errored) means "no image, no
  // vision candidates", never a retry — `captured: false` also keeps `attachImage` from running.
  let perceived: Awaited<ReturnType<PerceptionClient['perceive']>>;
  try {
    perceived = await deps.client.perceive(bitmap, regions, PERCEPTION_DEADLINE_MS, decision.fullFrame);
  } catch {
    return noVision({ capture: 'ok', worker: 'failed', level: 'L0' });
  }

  const timedOutIds = new Set(
    perceived.timedOut
      .map((box) => regions.find((r) => r.box[0] === box[0] && r.box[1] === box[1] && r.box[2] === box[2] && r.box[3] === box[3])?.id)
      .filter((id): id is string => id !== undefined),
  );
  const visionAnalyzedNodeIds = new Set(visionNodes.map((n) => n.id).filter((id) => !timedOutIds.has(id)));

  const visionCandidates: Candidate[] = perceived.candidates.map((c) => {
    const nodeId = c.regionId && c.regionId !== 'full-frame' ? c.regionId : undefined;
    // An OCR candidate with no owning node (pixel-only's whole-viewport region, or any future
    // caller in the same shape) needs SOME identity for fusion's `groupByOverlap` to key on —
    // otherwise every such candidate collapses into one shared, identity-less group (`groupKey`
    // falls back to `run:undefined`), losing per-line distinction entirely. The candidate's own
    // box is already unique per detected line and shared across multiple entities matched within
    // the same line (exactly the grouping a real DOM text run's `textRunId` would give it), so it
    // doubles as a synthetic run id with no new worker-protocol field needed.
    const textRunId = c.channel === 'text-ocr' && !nodeId ? `ocr-full-frame:${c.box.join(',')}` : undefined;
    return {
      entity: c.entity,
      box: c.box,
      score: c.score,
      channel: c.channel === 'text-ocr' ? 'text-ocr' : 'vision',
      // `ocr:` keeps a pixel-channel text match distinguishable in `redactions[].sources` from the
      // same recognizer firing on DOM text (both would otherwise read `pattern:<id>`).
      source: c.channel === 'text-ocr' ? `ocr:${c.source ?? c.entity.toLowerCase()}` : (c.source ?? `vision:${c.entity.toLowerCase()}`),
      nodeId,
      textRunId,
      value: c.value,
    };
  });

  return {
    visionCandidates,
    level: decision.level,
    captured: true,
    captureInconsistent: false,
    screenLabel: perceived.screenLabel,
    visionAnalyzedNodeIds,
    scale,
    status: { capture: 'ok', worker: 'ok', level: decision.level, regionsRequested, diagnostics: perceived.diagnostics },
  };
}

export { GeometryDigestGuard };

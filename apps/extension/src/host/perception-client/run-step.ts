// design.md §11's per-step orchestration glue: capture → geometry-digest check → `perceive` →
// map candidates into fusion's shape → (after `buildSanitizedContext` runs) attach the composed
// image. Factored out of `session.ts` so that file's step loop doesn't have to inline the whole
// capture/escalation/compose dance — this is the one place all of it is wired together.

import type { Candidate } from '../privacy/types';
import type { AblationArm } from '../../shared/ablation';
import type { Box } from '../../shared/worker-protocol';
import type { WireScreenNode } from '../../shared/messages';
import type { PerceptionClient } from './client';
import { decideEscalation, type PayloadLevel } from '../privacy/context/escalation';
import { structuralCoverage } from '../privacy/context/structural-coverage';
import { computeGeometryDigest, GeometryDigestGuard } from '../capture/digest';

const PERCEPTION_DEADLINE_MS = 120;
const IMAGE_LONG_SIDE_MAX_PX = 1600;

export interface CaptureFn {
  (): Promise<ImageBitmap | null>;
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
}

function isVisionNode(node: WireScreenNode): boolean {
  return node.role === 'img';
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
  const noCaptureNeeded = !pixelOnly && decision.level === 'L0' && visionNodes.length === 0;
  if (noCaptureNeeded) {
    return { visionCandidates: [], level: decision.level, captured: false, captureInconsistent: false, visionAnalyzedNodeIds: new Set(), scale };
  }

  const beforeDigest = await computeGeometryDigest(geometryBoxesOf(nodes));
  const bitmap = await deps.capture();
  if (!bitmap) {
    return { visionCandidates: [], level: 'L0', captured: false, captureInconsistent: false, visionAnalyzedNodeIds: new Set(), scale };
  }

  const freshNodes = await deps.reobserveGeometry();
  const afterDigest = await computeGeometryDigest(geometryBoxesOf(freshNodes));
  const digestVerdict = deps.digestGuard.check(beforeDigest, afterDigest);
  if (digestVerdict !== 'ok') {
    bitmap.close();
    return {
      visionCandidates: [],
      level: 'L0',
      captured: false,
      captureInconsistent: digestVerdict === 'degrade',
      visionAnalyzedNodeIds: new Set(),
      scale,
    };
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
        ...visionNodes.map((n) => ({ id: n.id, box: n.box as Box, kind: 'crop' as const })),
        ...(decision.fullFrame ? [{ id: 'full-frame', box: [0, 0, deps.viewport.w, deps.viewport.h] as Box, kind: 'full' as const }] : []),
      ];

  const perceived = await deps.client.perceive(bitmap, regions, PERCEPTION_DEADLINE_MS, decision.fullFrame);

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
      source: c.source ?? `vision:${c.entity.toLowerCase()}`,
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
  };
}

export { GeometryDigestGuard };

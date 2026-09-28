// design.md §7.5 / §4.3 — the L1/L2 image-attachment step, run AFTER `buildSanitizedContext` has
// already fused text+vision candidates into final `redactions`. Kept separate from `builder.ts`
// deliberately: builder.ts's text pipeline is synchronous and every existing caller/test depends
// on that; composing an image is an async round trip to the perception worker, and giving it its
// own function means the (much more common, L0) text-only path never pays for or depends on it.

import type { SanitizedContext } from '@aegis/protocol';
import type { Box } from '../../../shared/worker-protocol';
import { computeClearedBoxes, type ClearanceCandidate } from './clearance';

type SanitizedNode = SanitizedContext['nodes'][number];

export interface ComposeCall {
  (regions: { entity: string; boxes: Box[]; placeholder: string | null }[], cleared: Box[], scale: number): Promise<{ webp: ArrayBuffer; coverage: { cleared: number; redacted: number; unanalysed: number } }>;
}

export interface AttachImageInput {
  context: SanitizedContext;
  compose: ComposeCall;
  scale: number;
  /** Node ids whose vision analysis actually ran and completed this step (from the `perceive`
   * call's `candidates`/non-`timedOut` regions) — an image-bearing node not in this set was never
   * screened and must stay uncleared regardless of whether it happens to carry no redaction. */
  visionAnalyzedNodeIds: ReadonlySet<string>;
  /** True for nodes whose content type needs vision to clear at all (img/canvas/video — see
   * `structural-coverage.ts`'s `CoverageNode.requiresVision`). */
  nodeRequiresVision: (node: SanitizedNode) => boolean;
  legend: string;
}

function nodeHasRedaction(node: SanitizedNode): boolean {
  return node.value !== undefined && node.value !== null && (node.value.kind === 'placeholder' || node.value.kind === 'presence');
}

function toRegionInput(context: SanitizedContext): { entity: string; boxes: Box[]; placeholder: string | null }[] {
  return context.redactions.map((r) => ({ entity: r.entity, boxes: r.boxes as Box[], placeholder: r.ref ?? null }));
}

type BoxLike = readonly [number, number, number, number];

function intersects([ax, ay, aw, ah]: BoxLike, [bx, by, bw, bh]: BoxLike): boolean {
  return ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
}

/** Clearance rule 1's `hasUnanalysedImageContent`: the payload carries no DOM hierarchy, so
 * "contains" is approximated by box overlap — conservative, since an overlapping text box is
 * disqualified too. Without this, a clean-text container (article body, `<figure>`) was cleared and
 * the compositor copied in the pixels of an image nested inside it that vision never screened —
 * observed sending an unanalysed QR code on a real Wikipedia page once only one crop fit the
 * step deadline. */
function toClearanceCandidates(context: SanitizedContext, visionAnalyzedNodeIds: ReadonlySet<string>, nodeRequiresVision: (node: SanitizedNode) => boolean): ClearanceCandidate[] {
  const candidates: ClearanceCandidate[] = [];
  const unanalysedImageBoxes = context.nodes.filter((n) => nodeRequiresVision(n) && !visionAnalyzedNodeIds.has(n.id)).map((n) => n.box as BoxLike);
  const overlapsUnanalysedImage = (box: BoxLike) => unanalysedImageBoxes.some((b) => intersects(box, b));
  for (const node of context.nodes) {
    const requiresVision = nodeRequiresVision(node);
    const hadFinding = nodeHasRedaction(node);
    candidates.push({
      box: node.box as Box,
      kind: requiresVision ? 'vision-region' : 'structural-text',
      fullyAnalysed: requiresVision ? visionAnalyzedNodeIds.has(node.id) : true,
      hadAcceptedFinding: hadFinding,
      hasUnanalysedImageContent: !requiresVision && overlapsUnanalysedImage(node.box as BoxLike),
    });
  }
  for (const run of context.text) {
    const hadFinding = context.redactions.some((r) => r.boxes.some((b) => b[0] === run.box[0] && b[1] === run.box[1]));
    candidates.push({ box: run.box as Box, kind: 'structural-text', fullyAnalysed: true, hadAcceptedFinding: hadFinding, hasUnanalysedImageContent: overlapsUnanalysedImage(run.box as BoxLike) });
  }
  return candidates;
}

/** Returns `context` unchanged if there is nothing to redact into an image at all (no nodes) —
 * otherwise always returns a context with `image` set (never partially attached). */
export async function attachImage(input: AttachImageInput): Promise<SanitizedContext> {
  const { context, compose, scale, visionAnalyzedNodeIds, nodeRequiresVision, legend } = input;

  const cleared = computeClearedBoxes(toClearanceCandidates(context, visionAnalyzedNodeIds, nodeRequiresVision));
  const regions = toRegionInput(context);

  const composed = await compose(regions, cleared, scale);
  const sha256 = await sha256Hex(composed.webp);

  return {
    ...context,
    coverage: composed.coverage,
    image: {
      level: 'L1',
      region: [0, 0, context.viewport.w, context.viewport.h],
      scale,
      format: 'image/webp',
      sha256,
      data: arrayBufferToBase64(composed.webp),
      legend,
    },
  };
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

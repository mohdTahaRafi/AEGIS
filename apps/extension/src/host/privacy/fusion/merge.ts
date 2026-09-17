// design.md §7.1 step 3 (cross-channel agreement) and step 4 (group by overlap).
//
// Step 3 is a no-op this phase, exactly as declared in phase_3_privacy_core.md §16's forward
// dependencies: "Fusion step 3 (cross-channel agreement) ... has no OCR input" — there is no
// Channel V yet, so a DOM/text candidate never has an OCR counterpart to agree with. The function
// exists (rather than being skipped) so Phase 4 only has to fill it in, not invent the call site.

import type { Sensitivity } from '@aegis/policy';
import type { ArbitratedCandidate } from './arbitrate';

const CLASS_ORDER: Sensitivity[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export function crossChannelAgreement(candidates: readonly ArbitratedCandidate[]): ArbitratedCandidate[] {
  return candidates as ArbitratedCandidate[]; // no-op until Phase 4's Channel V exists
}

export interface CandidateGroup {
  key: string;
  members: ArbitratedCandidate[];
}

function groupKey(c: ArbitratedCandidate): string {
  // A field-value candidate groups by node; a free-text candidate groups by (run, overlapping
  // span) — computed in `groupByOverlap` below since span overlap needs pairwise comparison, not
  // a single hashable key.
  return c.nodeId ? `node:${c.nodeId}` : `run:${c.textRunId}`;
}

function spansOverlap(a?: [number, number], b?: [number, number]): boolean {
  if (!a || !b) return true; // no span on either side (e.g. a node-value candidate) — same group
  return a[0] < b[1] && b[0] < a[1];
}

function higherClass(a: Sensitivity, b: Sensitivity): Sensitivity {
  return CLASS_ORDER.indexOf(b) > CLASS_ORDER.indexOf(a) ? b : a;
}

/** Step 4: candidates that target the same node, or overlapping spans within the same text run,
 * merge into one group. Different entities within a group keep the highest class; `entities[]`
 * is the union (design.md §3.2's `SensitiveRegion.entities`). */
export function groupByOverlap(candidates: readonly ArbitratedCandidate[]): CandidateGroup[] {
  const byBucket = new Map<string, ArbitratedCandidate[]>();
  for (const c of candidates) {
    const bucket = groupKey(c);
    const list = byBucket.get(bucket) ?? [];
    list.push(c);
    byBucket.set(bucket, list);
  }

  const groups: CandidateGroup[] = [];
  for (const [bucket, members] of byBucket) {
    if (!bucket.startsWith('run:')) {
      groups.push({ key: bucket, members });
      continue;
    }
    // Within one text run, cluster by span overlap (a node-value candidate never reaches here).
    const clusters: ArbitratedCandidate[][] = [];
    for (const c of members) {
      const cluster = clusters.find((cl) => cl.some((m) => spansOverlap(m.span, c.span)));
      if (cluster) cluster.push(c);
      else clusters.push([c]);
    }
    clusters.forEach((cluster, i) => groups.push({ key: `${bucket}#${i}`, members: cluster }));
  }
  return groups;
}

export function mergedEntityAndClass(group: CandidateGroup): { entity: string; entities: string[]; class: Sensitivity; score: number } {
  let best = group.members[0]!;
  const entities = new Set<string>();
  let cls: Sensitivity = 'LOW';
  let score = 0;
  for (const m of group.members) {
    entities.add(m.entity);
    cls = higherClass(cls, m.class);
    score = Math.max(score, m.score);
    if (CLASS_ORDER.indexOf(m.class) > CLASS_ORDER.indexOf(best.class) || (m.class === best.class && m.score > best.score)) {
      best = m;
    }
  }
  return { entity: best.entity, entities: [...entities], class: cls, score };
}

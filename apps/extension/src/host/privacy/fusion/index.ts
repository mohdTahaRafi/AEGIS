// design.md §7.1 — the fusion algorithm's orchestrator. Steps 5-8 (rectangle decomposition,
// pixel dilation, OCR line fallback) operate on image geometry this phase never produces (no
// image — L0 only); they exist as separately tested pure functions (`decompose.ts`, `dilate.ts`)
// per phase_3_privacy_core.md §16's forward dependency, not wired in here. Step 7's *token*
// expansion (text, not pixels) DOES apply and is handled by the caller building text-run
// candidates, before they ever reach `fuse` — see `content/detect/spans.ts`'s caller in
// `host/privacy/context/builder.ts`.

import type { Policy } from '@aegis/policy';
import { arbitrate } from './arbitrate';
import { crossChannelAgreement, groupByOverlap, mergedEntityAndClass } from './merge';
import type { Candidate, SensitiveRegion } from '../types';

let regionCounter = 0;

export function resetRegionCounterForTesting(): void {
  regionCounter = 0;
}

export function fuse(policy: Policy, candidates: readonly Candidate[]): SensitiveRegion[] {
  const arbitrated = arbitrate(policy, candidates);
  const agreed = crossChannelAgreement(arbitrated);
  const groups = groupByOverlap(agreed);

  const regions: SensitiveRegion[] = [];
  for (const group of groups) {
    const { entity, entities, class: cls, score } = mergedEntityAndClass(group);
    // Step 10: LOW class produces no region — the caller treats the source value as plain text.
    if (cls === 'LOW') continue;

    const unverified = group.members.every((m) => m.unverified);
    const presenceOnly = group.members.some((m) => m.presenceOnly);
    const withValue = group.members.find((m) => m.value !== undefined);

    regionCounter += 1;
    regions.push({
      id: `r-${regionCounter}`,
      entity: entity as SensitiveRegion['entity'],
      entities: entities as SensitiveRegion['entities'],
      class: cls,
      score,
      boxes: group.members.map((m) => m.box),
      sources: group.members.map((m) => m.source),
      nodeId: group.members[0]!.nodeId,
      textRunId: group.members[0]!.textRunId,
      span: group.members[0]!.span,
      value: withValue?.value,
      presenceOnly,
      unverified,
    });
  }
  return regions;
}

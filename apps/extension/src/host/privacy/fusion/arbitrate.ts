// design.md §7.1 steps 1, 2, 9, 10 — class mapping, the fail-closed uncertainty band, LOW
// pass-through, and de-escalation restricted to versioned allow-rules.

import type { Policy } from '@aegis/policy';
import { bandFloor, entityClass, threshold } from '@aegis/policy';
import type { Candidate } from '../types';

export interface ArbitratedCandidate extends Candidate {
  class: import('@aegis/policy').Sensitivity;
  unverified: boolean;
}

/** Step 9: any channel may escalate; only an explicit versioned allow-rule may de-escalate. This
 * function only ever *raises* the effective class considered for thresholding relative to what an
 * allow-rule would otherwise suppress — it never silently drops a candidate for a reason other
 * than the score-vs-threshold test in `arbitrate`. */
function isAllowed(policy: Policy, candidate: Candidate): boolean {
  return policy.allowRules.some((rule) => rule.entity === candidate.entity);
}

/**
 * Steps 1-2 (+9-10): maps each candidate to a class, applies the fail-closed band, and drops
 * anything an explicit allow-rule covers. Step 10 (LOW → no region) is enforced by the caller
 * (the context builder), which treats an `ArbitratedCandidate` of class LOW as "pass through as
 * plain text" rather than filtering it here — the caller needs to know a LOW candidate existed
 * (for coverage accounting) even though it produces no redaction.
 */
export function arbitrate(policy: Policy, candidates: readonly Candidate[]): ArbitratedCandidate[] {
  const out: ArbitratedCandidate[] = [];
  for (const c of candidates) {
    if (isAllowed(policy, c)) continue;
    const cls = entityClass(policy, c.entity);
    const t = threshold(policy, cls);
    const floor = bandFloor(policy, cls);
    if (c.score >= t) {
      out.push({ ...c, class: cls, unverified: false });
    } else if (c.score >= floor) {
      out.push({ ...c, class: cls, unverified: true });
    }
    // else: dropped (step 2's lower branch)
  }
  return out;
}

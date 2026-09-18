// design.md §6.2 / phase_4_vision.md §6.1 — coverage-driven escalation. Initial tunables, to be
// re-derived from Phase 0's measured numbers and tuned by Phase 5's harness (§6.1's own caveat) —
// kept as data (thresholds, not branching logic scattered at call sites) for exactly that reason.

export type PayloadLevel = 'L0' | 'L1' | 'L2';

export const ESCALATION_THRESHOLDS = {
  /** `coverage.explained` at/above this: only element-level vision (img/video/canvas/avatar),
   * no full-frame capture, L0. */
  highCoverage: 0.92,
  /** Below this: full-frame vision, L1. Between the two: L0, or L1 if the server asked. */
  lowCoverage: 0.7,
} as const;

export interface EscalationInput {
  /** Fraction of the viewport's pixel area explained by structural (DOM-derived) content —
   * design.md §6.2's `coverage.explained`, distinct from the outbound payload's own
   * `coverage.cleared/redacted/unanalysed` (that one describes the *composited image*, this one
   * describes how much of the *page* needed vision at all). */
  explainedFraction: number;
  /** Set when the server issued `request_observation` for a specific region this step
   * (phase_4_vision.md §6.1's last row) — always escalates to a crop-only L2, regardless of
   * coverage. */
  serverRequestedRegion: { box: readonly [number, number, number, number] } | null;
}

export interface EscalationDecision {
  level: PayloadLevel;
  fullFrame: boolean;
  region: { box: readonly [number, number, number, number] } | null;
}

export function decideEscalation(input: EscalationInput): EscalationDecision {
  if (input.serverRequestedRegion) {
    return { level: 'L2', fullFrame: false, region: input.serverRequestedRegion };
  }
  if (input.explainedFraction >= ESCALATION_THRESHOLDS.highCoverage) {
    return { level: 'L0', fullFrame: false, region: null };
  }
  if (input.explainedFraction >= ESCALATION_THRESHOLDS.lowCoverage) {
    // design.md §6.1: "L0, or L1 if the server asked" — a bare coverage reading in this band
    // never escalates itself; only an explicit server request (handled above) does.
    return { level: 'L0', fullFrame: false, region: null };
  }
  return { level: 'L1', fullFrame: true, region: null };
}

// design.md §9.2 / phase_2_spine.md §5.4 — risk gating. The exact thresholds between 'medium' and
// 'high' are OQ-10, explicitly unresolved in the requirement docs; what's fixed and not up for
// negotiation is the ordering rule: **the model's `risk_hint` may only raise risk, never lower
// it** (the server is untrusted — architecture §10.2 — so a "low" hint on a submit button changes
// nothing). `classifyRisk` takes pre-extracted boolean signals rather than a raw `SanitizedContext`
// so it stays pure and testable; the caller (the host controller, once it exists) is responsible
// for deriving these from the context and the action's target node.

import type { WireAction } from '../../shared/messages';

export type RiskLevel = 'low' | 'medium' | 'high';

const ORDER: RiskLevel[] = ['low', 'medium', 'high'];

function max(a: RiskLevel, b: RiskLevel): RiskLevel {
  return ORDER.indexOf(b) > ORDER.indexOf(a) ? b : a;
}

export interface RiskSignals {
  /** A submit-shaped action inside a form that also holds a PASSWORD/OTP/CARD_* field. */
  formHasSensitiveField?: boolean;
  onBankingPage?: boolean;
  /** The target's accessible name matches delete/remove/send/pay/purchase/transfer. */
  highRiskVerbInName?: boolean;
  predictedCrossOriginNavigation?: boolean;
  isDownloadLink?: boolean;
}

/** [A] OQ-10: 'high' is reserved for the two named-explicitly-dangerous cases (a sensitive-field
 * form submit, or a banking page); everything else on design.md §9.2's initial risky list is
 * 'medium' — all of which require confirmation (`requiresConfirmation`), so this distinction is
 * for the panel's copy, not for whether the user is asked at all. */
export function classifyRisk(action: WireAction, signals: RiskSignals, modelHint?: RiskLevel): RiskLevel {
  let level: RiskLevel = 'low';

  if (signals.formHasSensitiveField || signals.onBankingPage) level = max(level, 'high');
  if (signals.highRiskVerbInName) level = max(level, 'medium');
  if (signals.predictedCrossOriginNavigation) level = max(level, 'medium');
  if (signals.isDownloadLink) level = max(level, 'medium');
  if (action.op === 'click_point') level = max(level, 'medium');

  if (modelHint) level = max(level, modelHint); // raises only — max() can never move `level` down
  return level;
}

export function requiresConfirmation(level: RiskLevel): boolean {
  return level !== 'low';
}

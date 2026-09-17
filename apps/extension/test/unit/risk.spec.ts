import { describe, expect, it } from 'vitest';
import { classifyRisk, requiresConfirmation } from '../../src/host/actions/risk';

const CLICK = { op: 'click', node: 'n-1' } as const;

describe('classifyRisk (design.md §9.2, OQ-10)', () => {
  it('a plain click with no risk signals is low risk and needs no confirmation', () => {
    const level = classifyRisk(CLICK, {});
    expect(level).toBe('low');
    expect(requiresConfirmation(level)).toBe(false);
  });

  it('a form submit on a sensitive field or a banking page is high risk', () => {
    expect(classifyRisk(CLICK, { formHasSensitiveField: true })).toBe('high');
    expect(classifyRisk(CLICK, { onBankingPage: true })).toBe('high');
  });

  it('a high-risk verb in the target name requires confirmation', () => {
    const level = classifyRisk(CLICK, { highRiskVerbInName: true });
    expect(requiresConfirmation(level)).toBe(true);
  });

  it('click_point always requires confirmation, even with no other signal', () => {
    const level = classifyRisk({ op: 'click_point', x: 10, y: 10, label: 'x' }, {});
    expect(requiresConfirmation(level)).toBe(true);
  });

  it('predicted cross-origin navigation and download links require confirmation', () => {
    expect(requiresConfirmation(classifyRisk(CLICK, { predictedCrossOriginNavigation: true }))).toBe(true);
    expect(requiresConfirmation(classifyRisk(CLICK, { isDownloadLink: true }))).toBe(true);
  });

  it("the model's risk_hint can raise the level above what the client itself computed", () => {
    const level = classifyRisk(CLICK, {}, 'high');
    expect(level).toBe('high');
  });

  it("the model's risk_hint can never lower a level the client itself computed as higher", () => {
    const level = classifyRisk(CLICK, { formHasSensitiveField: true }, 'low');
    expect(level).toBe('high');
  });
});

import { describe, expect, it } from 'vitest';
import { decideEscalation, ESCALATION_THRESHOLDS } from '../../src/host/privacy/context/escalation';

describe('decideEscalation (phase_4_vision.md §6.1)', () => {
  it('high structural coverage → L0, no full frame', () => {
    const d = decideEscalation({ explainedFraction: ESCALATION_THRESHOLDS.highCoverage, serverRequestedRegion: null });
    expect(d).toEqual({ level: 'L0', fullFrame: false, region: null });
  });

  it('mid-band coverage stays L0 absent a server request', () => {
    const d = decideEscalation({ explainedFraction: 0.8, serverRequestedRegion: null });
    expect(d.level).toBe('L0');
    expect(d.fullFrame).toBe(false);
  });

  it('low coverage escalates to full-frame L1', () => {
    const d = decideEscalation({ explainedFraction: 0.5, serverRequestedRegion: null });
    expect(d).toEqual({ level: 'L1', fullFrame: true, region: null });
  });

  it('a server-requested region always wins, regardless of coverage', () => {
    const region = { box: [10, 10, 20, 20] as const };
    const d = decideEscalation({ explainedFraction: 0.99, serverRequestedRegion: region });
    expect(d).toEqual({ level: 'L2', fullFrame: false, region });
  });
});

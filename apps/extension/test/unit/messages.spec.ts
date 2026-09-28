import { describe, expect, it } from 'vitest';
import { isContentToHostMessage } from '../../src/shared/messages';

const GRAPH = { type: 'graph', frame: 'f-0', nodes: [], removed: [], textRuns: [], privacyEpoch: 0, reason: 'initial', hostileDynamic: false };

describe('isContentToHostMessage — graph viewport', () => {
  it('accepts a graph with the page viewport, and one without (older sender / test fake)', () => {
    expect(isContentToHostMessage({ ...GRAPH, viewport: { w: 1280, h: 720, dpr: 1, scrollY: 0, docH: 900 } })).toBe(true);
    expect(isContentToHostMessage(GRAPH)).toBe(true);
  });

  it('rejects a malformed viewport rather than letting it size the payload and the crops', () => {
    expect(isContentToHostMessage({ ...GRAPH, viewport: { w: 1280, h: 720 } })).toBe(false);
    expect(isContentToHostMessage({ ...GRAPH, viewport: { w: 'wide', h: 720, dpr: 1, scrollY: 0, docH: 900 } })).toBe(false);
    expect(isContentToHostMessage({ ...GRAPH, viewport: { w: Number.NaN, h: 720, dpr: 1, scrollY: 0, docH: 900 } })).toBe(false);
  });
});

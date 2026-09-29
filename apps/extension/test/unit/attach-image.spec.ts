// `attachImage` decides which boxes the compositor copies in from the real capture. Regression for
// a leak observed on a real Wikipedia page: the article container's text was clean, so it was
// cleared — and the QR-code <img> inside it, whose crop never ran before the step deadline, was
// copied into the outgoing image along with it.

import { describe, expect, it, vi } from 'vitest';
import type { SanitizedContext } from '@aegis/protocol';
import { attachImage } from '../../src/host/privacy/context/attach-image';

type Node = SanitizedContext['nodes'][number];

function node(id: string, role: string, box: [number, number, number, number]): Node {
  return {
    id,
    role,
    name: '',
    box,
    frame: 'f-0',
    z: 0,
    state: { focused: false, disabled: false, readonly: false, required: false, has_value: false, value_len: 0, occluded: false, volatile: false },
    affordances: [],
  } as Node;
}

const CONTAINER = node('n-1', 'main', [0, 0, 1000, 800]);
const IMAGE = node('n-2', 'img', [600, 300, 200, 200]);
const SIDEBAR = node('n-3', 'navigation', [0, 0, 150, 800]);

function context(): SanitizedContext {
  return {
    schema: 'AEGIS/1',
    step_id: 's-1',
    task: 't',
    reason: 'initial',
    delta_of: null,
    viewport: { w: 1000, h: 800, dpr: 1, scroll_y: 0, doc_h: 800 },
    page: { category: 'unknown', title: '' },
    nodes: [CONTAINER, IMAGE, SIDEBAR],
    text: [{ id: 't-1', box: [20, 20, 400, 30], text: 'Clean paragraph' }, { id: 't-2', box: [610, 480, 180, 30], text: 'Overlapping caption' }],
    redactions: [],
    unexplained: [],
    coverage: { cleared: 1, redacted: 0, unanalysed: 0 },
    image: null,
    history: [],
    client_timing: {},
  } as unknown as SanitizedContext;
}

async function clearedBoxesFor(analysed: string[]) {
  const compose = vi.fn(async () => ({ webp: new ArrayBuffer(8), coverage: { cleared: 0.5, redacted: 0, unanalysed: 0.5 } }));
  await attachImage({
    context: context(),
    compose,
    scale: 1,
    visionAnalyzedNodeIds: new Set(analysed),
    nodeRequiresVision: (n) => n.role === 'img',
    legend: '',
  });
  return (compose.mock.calls[0] as unknown as [unknown, number[][], number])[1];
}

describe('attachImage clearance — unanalysed images stay grey', () => {
  it('an unanalysed image is never copied in via a clean container that encloses it', async () => {
    const cleared = await clearedBoxesFor([]);
    expect(cleared).not.toContainEqual(CONTAINER.box);
    expect(cleared).not.toContainEqual(IMAGE.box);
    // Unrelated clean structure elsewhere is still cleared (not a blanket grey-out).
    expect(cleared).toContainEqual(SIDEBAR.box);
    expect(cleared).toContainEqual([20, 20, 400, 30]);
  });

  it('text overlapping the unanalysed image is not cleared either', async () => {
    const cleared = await clearedBoxesFor([]);
    expect(cleared).not.toContainEqual([610, 480, 180, 30]);
  });

  it('once the image itself was analysed (no finding), both it and its container clear', async () => {
    const cleared = await clearedBoxesFor(['n-2']);
    expect(cleared).toContainEqual(IMAGE.box);
    expect(cleared).toContainEqual(CONTAINER.box);
  });
});

describe('attachImage — label-protected fields are masked regardless of value', () => {
  it('draws an empty sensitive field as a labelled black box, even inside a cleared container, without a redactions entry', async () => {
    const compose = vi.fn(async () => ({ webp: new ArrayBuffer(8), coverage: { cleared: 0.5, redacted: 0.1, unanalysed: 0.4 } }));
    const out = await attachImage({
      context: context(),
      compose,
      scale: 1,
      visionAnalyzedNodeIds: new Set(['n-2']),
      nodeRequiresVision: (n) => n.role === 'img',
      legend: '',
      maskedFields: [{ entity: 'EMAIL', box: [20, 100, 300, 40] }],
    });
    const [regions, cleared] = compose.mock.calls[0] as unknown as [{ entity: string; boxes: number[][]; placeholder: string | null }[], number[][]];
    expect(regions).toContainEqual({ entity: 'EMAIL', boxes: [[20, 100, 300, 40]], placeholder: 'EMAIL field' });
    expect(cleared).toContainEqual([0, 0, 1000, 800]); // the container is still copied; the mask is drawn over it
    expect(out.redactions).toEqual([]);
  });
});

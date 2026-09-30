import type { SanitizedContext } from '@aegis/protocol';

type Node = SanitizedContext['nodes'][number];

export function fakeNode(id: string, overrides: Partial<Node> = {}): Node {
  return { id, role: 'button', name: 'Sign in', box: [220, 530, 120, 36], frame: 'f-0', z: 0, state: {}, affordances: ['click'], ...overrides };
}

export function fakeStep(overrides: Partial<SanitizedContext> = {}): SanitizedContext {
  return {
    schema: 'AEGIS/1',
    step_id: 's-1',
    task: 'sign in',
    reason: 'initial',
    viewport: { w: 1280, h: 720, dpr: 1, scroll_y: 0, doc_h: 720 },
    page: { category: 'unknown', title: 'Test' },
    nodes: [
      fakeNode('n-user', { role: 'textbox', name: 'Username', box: [220, 418, 340, 40], state: { has_value: false }, affordances: ['click', 'type'] }),
      fakeNode('n-go'),
    ],
    text: [],
    redactions: [],
    unexplained: [],
    coverage: { cleared: 1, redacted: 0, unanalysed: 0 },
    history: [],
    client_timing: {},
    ...overrides,
  };
}

export const IMAGE = { level: 'L1', region: [0, 0, 1280, 720], scale: 0.5, format: 'image/webp', sha256: 'x', data: 'QUJD', legend: 'black = redacted' } as const;

export function withImage(step: SanitizedContext): SanitizedContext {
  return { ...step, image: { ...IMAGE, region: [...IMAGE.region] as [number, number, number, number] } };
}

import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT, buildMessages, buildUserMessage, nodeAliases, resolveAliases } from '../../src/host/agent/prompt';
import { fakeNode, fakeStep, withImage } from './agent-fixtures';

describe('agent prompt', () => {
  it('lists elements by short alias, with role, name, box and state flags', () => {
    const text = buildUserMessage(fakeStep());
    expect(text).toContain('TASK: sign in');
    expect(text).toContain('e1 | textbox | "Username" | [220,418,340,40] | empty');
    expect(text).toContain('e2 | button | "Sign in" | [220,530,120,36]');
    expect(text).not.toContain('n-user');
  });

  it('shows "has value" only on fields', () => {
    const step = fakeStep({ nodes: [fakeNode('n-a', { state: { has_value: true } }), fakeNode('n-b', { role: 'textbox', affordances: ['type'], state: { has_value: true } })] });
    const text = buildUserMessage(step);
    expect(text).toMatch(/e1 \| button \| "Sign in" \| \[[\d,]+\]$/m);
    expect(text).toMatch(/e2 \| textbox .* \| has value/);
  });

  it('renders history with the alias of the element an action touched', () => {
    const step = fakeStep({ history: [{ step_id: 's-0', actions: [{ op: 'type', node: 'n-user' }, { op: 'click', node: 'n-gone' }], outcome: 'ok' }] });
    expect(buildUserMessage(step)).toContain('HISTORY: s-0: type e1, click -> ok');
  });

  it('puts the redaction legend, boxes and image header in only when an image is attached', () => {
    const redactions = [{ ref: '⟪AADHAAR#1⟫', entity: 'AADHAAR', class: 'CRITICAL', boxes: [[10, 20, 30, 40]], method: 'placeholder', confidence: 1, sources: ['t'], unverified: false }] as never;
    const step = withImage(fakeStep({ redactions }));
    const without = buildUserMessage(step);
    expect(without).toContain('⟪AADHAAR#1⟫ | AADHAAR | CRITICAL\n');
    expect(without).not.toContain('IMAGE:');
    const withImg = buildUserMessage(step, { withImage: true });
    expect(withImg).toContain('⟪AADHAAR#1⟫ | AADHAAR | CRITICAL | [10,20,30,40]');
    expect(withImg).toContain('IMAGE: level=L1 region=[0,0,1280,720] scale=0.5 cleared=1.00 redacted=0.00 unanalysed=0.00');
    expect(withImg).toContain('LEGEND: black = redacted');
  });

  it('always sends the screenshot with the step, as a data URL image part', () => {
    const [system, user] = buildMessages(withImage(fakeStep()));
    expect(system).toEqual({ role: 'system', content: SYSTEM_PROMPT });
    const parts = user!.content as { type: string }[];
    expect(parts.map((p) => p.type)).toEqual(['text', 'image_url']);
    expect(JSON.stringify(parts[1])).toContain('data:image/webp;base64,QUJD');
  });

  it('drops decorative noise and caps the element list by `fit`', () => {
    const nodes = [
      fakeNode('n-tiny', { role: 'img', name: '', box: [0, 0, 2, 2], affordances: [] }),
      ...Array.from({ length: 60 }, (_, i) => fakeNode(`n-${i}`, { name: `Button ${i}`, box: [10, 10 + i * 5, 80, 20] })),
    ];
    const full = buildUserMessage(fakeStep({ nodes }));
    expect(full).toContain('(16 more elements off-screen or not shown)');
    expect(full).not.toContain('img');
    const small = buildUserMessage(fakeStep({ nodes }), { fit: 0.2 });
    expect(small.split('\n').filter((l) => /^e\d+ \|/.test(l))).toHaveLength(10);
  });

  it('keeps off-screen prose out of the text runs and never repeats an element name', () => {
    const step = fakeStep({
      text: [
        { id: 't1', box: [0, 0, 100, 20], text: 'Welcome back' },
        { id: 't2', box: [0, 2000, 100, 20], text: 'Way down the page' },
        { id: 't3', box: [0, 0, 100, 20], text: 'Sign in' },
      ],
    });
    const text = buildUserMessage(step);
    expect(text).toContain('TEXT: "Welcome back"');
    expect(text).not.toContain('Way down');
  });

  it('maps the model\'s aliases back to real node ids and leaves unknown ones for validation', () => {
    const step = fakeStep();
    expect([...nodeAliases(step)]).toEqual([['n-user', 'e1'], ['n-go', 'e2']]);
    const plan = { actions: [{ op: 'click', node: 'e2' }, { op: 'click', node: 'e9' }, { op: 'wait', ms: 100 }] };
    resolveAliases(plan, step);
    expect(plan.actions.map((a) => (a as { node?: string }).node)).toEqual(['n-go', 'e9', undefined]);
  });
});

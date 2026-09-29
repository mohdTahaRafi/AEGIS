// @vitest-environment jsdom
// Label-bound values: a value is sealed by what its label says it is, whatever its format, and
// wherever it reappears; a container's concatenated name never widens its redaction box.

import { defaultPolicy } from '@aegis/policy';
import { afterEach, describe, expect, it } from 'vitest';
import { labelEntityFor } from '../../src/content/detect/spans';
import { buildSanitizedContext } from '../../src/host/privacy/context/builder';
import { Vault } from '../../src/host/privacy/vault';
import type { WireScreenNode, WireTextRun } from '../../src/shared/messages';

function run(id: string, text: string, box: [number, number, number, number], labelEntity?: WireTextRun['labelEntity']): WireTextRun {
  return { id, text, box, ...(labelEntity ? { labelEntity } : {}) };
}

function generic(id: string, name: string, box: [number, number, number, number], role = 'generic'): WireScreenNode {
  return {
    id,
    frame: 'f-0',
    role,
    name,
    box,
    z: 0,
    state: { focused: false, disabled: false, readonly: false, required: false, hasValue: false, valueLen: 0, occluded: false, volatile: false },
    affordances: [],
    container: 'c-1',
    textRuns: [],
  };
}

function build(nodes: WireScreenNode[], textRuns: WireTextRun[], task = 'Enter the username and click Sign in.') {
  return buildSanitizedContext({
    stepId: 's-1',
    task,
    reason: 'initial',
    viewport: { w: 1280, h: 800, dpr: 1, scrollY: 0, docH: 800 },
    pageCategory: 'unknown',
    pageTitle: 'Sign in',
    nodes,
    removed: [],
    textRuns,
    history: [],
    clientTiming: {},
    vault: new Vault(),
    policy: defaultPolicy,
    originKey: 'origin:test',
  });
}

describe('label-bound values (builder)', () => {
  it('seals a value whose DOM label names an entity, even when no recognizer parses it', () => {
    const ctx = build([], [run('t-1', 'Registered username', [0, 0, 140, 19]), run('t-2', 'rkumar_2291', [150, 0, 100, 19], 'USERNAME')]);
    const bytes = JSON.stringify(ctx);
    expect(bytes).not.toContain('rkumar_2291');
    expect(ctx.text.find((t) => t.id === 't-2')!.text).toMatch(/^⟪USERNAME#\d+⟫$/);
    expect(ctx.redactions.find((r) => r.entity === 'USERNAME')!.sources).toContain('label:username');
  });

  it('seals an inline "Label: value" run', () => {
    const ctx = build([], [run('t-1', 'Mobile: 98-7654-3210 (office)', [0, 0, 300, 19])]);
    expect(JSON.stringify(ctx)).not.toContain('98-7654-3210');
    expect(ctx.text[0]!.text).toMatch(/^Mobile: ⟪PHONE#\d+⟫$/);
  });

  it('seals the same value wherever else it appears (an ancestor name, the task) with the same ref', () => {
    const main = generic('n-main', 'Your account Registered username rkumar_2291 Sign in', [0, 0, 900, 500], 'main');
    const ctx = build([main], [run('t-2', 'rkumar_2291', [150, 40, 100, 19], 'USERNAME')], 'Sign in as rkumar_2291');
    const ref = ctx.text[0]!.text;
    expect(ctx.nodes[0]!.name).toBe(`Your account Registered username ${ref} Sign in`);
    expect(ctx.task).toBe(`Sign in as ${ref}`);
    expect(JSON.stringify(ctx)).not.toContain('rkumar_2291');
  });

  it("keeps only the tightest box per ref: an ancestor's box does not black out the whole region", () => {
    const main = generic('n-main', 'Aadhaar 4987 1234 5679', [0, 0, 900, 500], 'main');
    const ctx = build([main], [run('t-1', 'Aadhaar', [0, 40, 60, 19]), run('t-2', '4987 1234 5679', [70, 40, 120, 19], 'AADHAAR')]);
    const boxes = ctx.redactions.filter((r) => r.entity === 'AADHAAR').flatMap((r) => r.boxes);
    expect(boxes.length).toBeGreaterThan(0);
    expect(boxes.every((b) => b[2] === 120 && b[3] === 19)).toBe(true);
  });

  it('propagates only whole-token occurrences', () => {
    const ctx = build([generic('n-1', 'Notice: Sam will call', [0, 50, 300, 19])], [run('t-1', 'Sam', [0, 0, 40, 19], 'PERSON_NAME')], 'Call Sam today about Samsung');
    expect(ctx.task).toMatch(/^Call ⟪PERSON_NAME#\d+⟫ today about Samsung$/);
    expect(ctx.nodes[0]!.name).toMatch(/^Notice: ⟪PERSON_NAME#\d+⟫ will call$/);
  });

  it('leaves plain prose and non-entity labels alone', () => {
    const ctx = build([], [run('t-1', 'Office hours: Monday to Friday, 9:30 to 17:30.', [0, 0, 300, 19])]);
    expect(ctx.text[0]!.text).toBe('Office hours: Monday to Friday, 9:30 to 17:30.');
    expect(ctx.redactions).toEqual([]);
  });
});

describe('labelEntityFor (content, DOM association only)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('reads the <dt> of a <dd>', () => {
    document.body.innerHTML = '<dl><dt>Mobile</dt><dd id="v">+91 98765 43210</dd><dt>Registered username</dt><dd id="u">rkumar_2291</dd></dl>';
    expect(labelEntityFor(document.getElementById('v')!, '+91 98765 43210')).toBe('PHONE');
    expect(labelEntityFor(document.getElementById('u')!, 'rkumar_2291')).toBe('USERNAME');
  });

  it('reads the row header of a <td> and a preceding "Label:" sibling', () => {
    document.body.innerHTML = '<table><tr><th>PAN</th><td id="p">ABCPK1234F</td></tr></table><div><span>Email:</span><span id="e">x</span></div>';
    expect(labelEntityFor(document.getElementById('p')!, 'ABCPK1234F')).toBe('PAN');
    expect(labelEntityFor(document.getElementById('e')!, 'x')).toBe('EMAIL');
  });

  it('ignores labels themselves, long prose, and unrelated neighbours', () => {
    document.body.innerHTML = '<dl><dt id="l">Mobile</dt><dd id="d">Call us any time during office hours and we will get back to you as soon as we can, promise.</dd></dl><p>Name</p><p id="x">Welcome back</p>';
    expect(labelEntityFor(document.getElementById('l')!, 'Mobile')).toBeUndefined();
    expect(labelEntityFor(document.getElementById('d')!, document.getElementById('d')!.textContent!)).toBeUndefined();
    expect(labelEntityFor(document.getElementById('x')!, 'Welcome back')).toBeUndefined();
  });
});

describe('a sensitive field value supplied by the task', () => {
  it('is sealed in the task too (any case), so the guard passes instead of blocking VAULT_LEAK', async () => {
    const { guard } = await import('../../src/host/privacy/guard/guard');
    const field: WireScreenNode = {
      ...generic('n-login', 'Login ID *', [96, 170, 448, 42], 'textbox'),
      affordances: ['click', 'type'],
      state: { focused: false, disabled: false, readonly: false, required: true, hasValue: true, valueLen: 9, occluded: false, volatile: false },
      field: { inputType: 'text', maskedCss: false, valueRead: true, value: 'TEST-USER' },
      domSignal: { entity: 'USERNAME', score: 0.75, valueRead: true, source: 'nearby' },
    };
    const vault = new Vault();
    const ctx = buildSanitizedContext({
      stepId: 's-2', task: 'Type test-user into the Login ID field.', reason: 'initial',
      viewport: { w: 1280, h: 800, dpr: 1, scrollY: 0, docH: 800 }, pageCategory: 'unknown', pageTitle: 'Login',
      nodes: [field], removed: [], textRuns: [], history: [], clientTiming: {}, vault, policy: defaultPolicy, originKey: 'origin:test',
    });
    expect(ctx.task).toMatch(/^Type ⟪USERNAME#\d+⟫ into the Login ID field\.$/);
    expect(JSON.stringify(ctx).toLowerCase()).not.toContain('test-user');
    await expect(guard(ctx, defaultPolicy, vault, {})).resolves.toBeDefined();
  });
});

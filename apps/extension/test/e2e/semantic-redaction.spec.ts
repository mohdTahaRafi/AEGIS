// Semantic-first redaction, end to end in real Chromium: real DOM extraction → Channel D field
// semantics → Channel T → fusion → vault → guard. The regression this pins: redaction used to
// exist only when the VALUE matched a recognizer, so "Email ID" = "abc" shipped as plain text and
// a "Password"-labelled `type=text` field had its value read and sent raw. A field's type now
// comes from the evidence bound to it; changing the value (valid → malformed → arbitrary → empty)
// must never remove its redaction.

import { defaultPolicy } from '@aegis/policy';
import type { EntityType } from '@aegis/recognizers';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyFieldSemantics } from '../../src/content/detect/field-semantics';
import { extractScreenGraph } from '../../src/content/screen-graph/extractor';
import { ContainerResolver, createNodeIdentityRegistry } from '../../src/content/screen-graph/identity';
import { resolveRehydration } from '../../src/host/actions/rehydrate';
import { buildSanitizedContext } from '../../src/host/privacy/context/builder';
import { guard } from '../../src/host/privacy/guard/guard';
import { Vault } from '../../src/host/privacy/vault';
import type { WireScreenNode } from '../../src/shared/messages';

const PROTECTED: ReadonlySet<EntityType> = new Set(['PASSWORD', 'OTP', 'CARD_NUMBER', 'CARD_CVV', 'SECRET']);

afterEach(() => {
  document.body.innerHTML = '';
});

function extractGraph(): { nodes: WireScreenNode[]; idOf: (el: Element) => string | undefined } {
  const graph = extractScreenGraph(createNodeIdentityRegistry(), new ContainerResolver(), {});
  const nodes = graph.nodes.map(({ key: _key, ...wire }) => wire);
  const idOf = (el: Element) => [...graph.elements].find(([, e]) => e === el)?.[0];
  return { nodes, idOf };
}

function extractNodes(): WireScreenNode[] {
  return extractGraph().nodes;
}

function build(vault: Vault, nodes: WireScreenNode[]) {
  return buildSanitizedContext({
    stepId: 's-1',
    task: 'fill the form',
    reason: 'initial',
    viewport: { w: 800, h: 600, dpr: 1, scrollY: 0, docH: 600 },
    pageCategory: 'gov',
    pageTitle: 'Application form',
    nodes,
    removed: [],
    textRuns: [],
    history: [],
    clientTiming: {},
    vault,
    policy: defaultPolicy,
    originKey: 'origin:test',
  });
}

function field(): HTMLInputElement {
  return (document.getElementById('f') ?? document.querySelector('[data-field]')) as HTMLInputElement;
}

/** Runs the full pipeline for the field `#f` and returns its sanitized value + the raw bytes. */
async function sanitizeField(value: string) {
  field().value = value;
  const vault = new Vault();
  const { nodes, idOf } = extractGraph();
  const target = nodes.find((n) => n.id === idOf(field()))!;
  const context = build(vault, nodes);
  const bytes = JSON.stringify(context);
  const guarded = await guard(context, defaultPolicy, vault).then(
    () => 'ok',
    (e: Error) => e.message,
  );
  const sanitized = context.nodes.find((n) => n.id === target.id)!;
  return { value: sanitized.value, bytes, guarded, target, context, vault };
}

// Values that exercise "valid", "malformed" and "arbitrary" for each type. Every value is at least
// three characters and never a substring of the label, so a raw-bytes check is meaningful.
const CASES: { label: string; entity: EntityType; values: string[] }[] = [
  { label: 'Email ID', entity: 'EMAIL', values: ['person@example.com', 'abc', 'person@', 'zq9 !x'] },
  { label: 'Mobile Number', entity: 'PHONE', values: ['9876543210', 'abc', '98765', 'zq9 !x'] },
  { label: 'Aadhaar Number', entity: 'AADHAAR', values: ['2345 6789 0124', '123', 'abcd efgh', 'zq9 !x'] },
  { label: 'PAN', entity: 'PAN', values: ['ABCPE1234F', 'ABC', 'zq9 !x'] },
  { label: 'Passport Number', entity: 'PASSPORT', values: ['K1234567', 'K12', 'zq9 !x'] },
  { label: 'Date of Birth', entity: 'DOB', values: ['12/05/1990', '31/31/31', 'zq9 !x'] },
  { label: 'Full Name', entity: 'PERSON_NAME', values: ['Ramesh Kumar', 'zq9 !x'] },
  { label: 'Username', entity: 'USERNAME', values: ['ramesh_k', 'person@example.com', 'zq9 !x'] },
  { label: 'Address', entity: 'ADDRESS', values: ['12 MG Road, Pune', 'zq9 !x'] },
  { label: 'Bank Account Number', entity: 'BANK_ACCOUNT', values: ['123456789012', 'abc', 'zq9 !x'] },
  { label: 'UPI ID', entity: 'UPI_VPA', values: ['ramesh@okaxis', 'abc', 'zq9 !x'] },
  { label: 'Password', entity: 'PASSWORD', values: ['hunter2-battery', 'abc', 'zq9 !x'] },
  { label: 'OTP', entity: 'OTP', values: ['482913', 'abc', 'zq9 !x'] },
  { label: 'Card Number', entity: 'CARD_NUMBER', values: ['4111 1111 1111 1111', '4111', 'zq9 !x'] },
  { label: 'CVV', entity: 'CARD_CVV', values: ['123', 'abc', 'zq9 !x'] },
];

describe('semantic-first redaction — valid, malformed and arbitrary values under every sensitive label', () => {
  for (const { label, entity, values } of CASES) {
    for (const value of values) {
      it(`"${label}" = ${JSON.stringify(value)} → ${entity}, raw value absent, guard passes`, async () => {
        document.body.innerHTML = `<form><label for="f">${label}</label><input id="f" type="text"></form>`;
        const { value: sent, bytes, guarded } = await sanitizeField(value);

        expect(bytes).not.toContain(value);
        expect(guarded).toBe('ok');
        if (PROTECTED.has(entity)) {
          expect(sent).toEqual({ kind: 'presence', entity, len: value.length });
        } else {
          expect(sent).toMatchObject({ kind: 'placeholder', entity, len: value.length });
        }
      });
    }

    it(`"${label}" left empty keeps its semantic type and sends no value and no ref`, async () => {
      document.body.innerHTML = `<form><label for="f">${label}</label><input id="f" type="text"></form>`;
      const { value: sent, target, context } = await sanitizeField('');
      expect(target.domSignal?.entity).toBe(entity);
      expect(context.redactions.filter((r) => r.ref !== null)).toHaveLength(0);
      if (PROTECTED.has(entity)) expect(sent).toEqual({ kind: 'presence', entity, len: 0 });
      else expect(sent).toEqual({ kind: 'text', text: '' });
    });
  }

  it('changing one live field valid → malformed → arbitrary → empty → valid never drops its type', async () => {
    document.body.innerHTML = '<form><label for="f">Email ID</label><input id="f" type="text"></form>';
    for (const value of ['person@example.com', 'abc', 'zq9 !x', '', 'other@example.org']) {
      const { value: sent, bytes } = await sanitizeField(value);
      if (value === '') {
        expect(sent).toEqual({ kind: 'text', text: '' });
      } else {
        expect(sent).toMatchObject({ kind: 'placeholder', entity: 'EMAIL' });
        expect(bytes).not.toContain(value);
      }
    }
  });
});

describe('semantic-first redaction — every way a page binds a label to a field', () => {
  const BINDINGS: [string, string][] = [
    ['<label for>', '<label for="f">Email ID</label><input id="f" type="text">'],
    ['wrapping <label>', '<label>Email ID <input id="f" type="text"></label>'],
    ['aria-label', '<input id="f" type="text" aria-label="Email ID">'],
    ['aria-labelledby', '<span id="cap">Email ID</span><input id="f" type="text" aria-labelledby="cap">'],
    ['placeholder', '<input id="f" type="text" placeholder="Enter your email">'],
    ['name attribute', '<input id="f" type="text" name="txtEmailId">'],
    ['id attribute', '<input id="emailAddress" data-field type="text">'],
    ['autocomplete', '<input id="f" type="text" autocomplete="email">'],
    ['type=email', '<input id="f" type="email">'],
    ['table-cell caption', '<table><tr><td>Email ID</td><td><input id="f" type="text"></td></tr></table>'],
    ['sibling-div caption', '<div class="row"><div class="lbl">E-mail</div><div class="ctl"><input id="f" type="text"></div></div>'],
    // React Native Web, as served by Passport Seva's registration page (2026-09-28): no <label>,
    // no name/id/placeholder, caption beside the input's 5th wrapper.
    [
      'deeply nested framework caption',
      '<div><div> Email ID *</div><div><div><div><div><div><input id="f" type="text" autocomplete="none"></div></div></div></div></div></div>',
    ],
  ];

  for (const [how, html] of BINDINGS) {
    it(`${how}: "abc" is still sealed as EMAIL`, async () => {
      document.body.innerHTML = `<form>${html}</form>`;
      const { value: sent, bytes, guarded } = await sanitizeField('abc');
      expect(sent).toMatchObject({ kind: 'placeholder', entity: 'EMAIL', len: 3 });
      expect(bytes).not.toMatch(/"abc"/);
      expect(guarded).toBe('ok');
    });
  }
});

describe('semantic-first redaction — association, not keyword presence', () => {
  it('the word "email" elsewhere on the page does not classify an unrelated field', () => {
    document.body.innerHTML = `
      <p>We will never share your email address or mobile number.</p>
      <form><label for="f">Remarks</label><input id="f" type="text"></form>`;
    expect(classifyFieldSemantics(field())).toBeUndefined();
  });

  it('a neighbouring field’s label is not borrowed by an unlabelled field', () => {
    document.body.innerHTML = '<form><label for="a">Email ID</label><input id="a"><input id="f" type="text"></form>';
    expect(classifyFieldSemantics(field())).toBeUndefined();
  });

  it('in a nested framework form, each field takes its own caption, never the previous field’s', () => {
    const row = (caption: string, id: string) =>
      `<div><div>${caption}</div><div><div><div><div><div><input id="${id}" type="text"></div></div></div></div></div></div>`;
    document.body.innerHTML = `<form><div>${row('Email ID *', 'a')}${row('Login ID *', 'b')}${row('Enter the characters shown in the image *', 'f')}</div></form>`;
    expect(classifyFieldSemantics(document.getElementById('a')!)?.entity).toBe('EMAIL');
    expect(classifyFieldSemantics(document.getElementById('b')!)?.entity).toBe('USERNAME');
    expect(classifyFieldSemantics(field())).toBeUndefined();
  });

  it('a section heading is not a field caption', () => {
    document.body.innerHTML = '<form><div><h3>Email preferences</h3><input id="f" type="text"></div></form>';
    expect(classifyFieldSemantics(field())).toBeUndefined();
  });

  it('long prose before a field is not a caption', () => {
    document.body.innerHTML =
      '<form><div><span>We will send a confirmation to the email address you registered with when you first signed up.</span><input id="f" type="text"></div></form>';
    expect(classifyFieldSemantics(field())).toBeUndefined();
  });

  it('an unlabelled field with no semantics is still redacted when its value is recognisably sensitive', async () => {
    document.body.innerHTML = '<form><label for="f">Search</label><input id="f" type="text"></form>';
    const { value: sent, bytes } = await sanitizeField('person@example.com');
    expect(sent).toMatchObject({ kind: 'placeholder', entity: 'EMAIL' });
    expect(bytes).not.toContain('person@example.com');
  });

  it('an unlabelled, non-sensitive field with an ordinary value passes through as text', async () => {
    document.body.innerHTML = '<form><label for="f">Search</label><input id="f" type="text"></form>';
    const { value: sent } = await sanitizeField('cardiologist');
    expect(sent).toEqual({ kind: 'text', text: 'cardiologist' });
  });
});

describe('semantic-first redaction — conflicts between label and value format', () => {
  it('Username holding an email-shaped value is USERNAME, and rehydrates back into that field', async () => {
    document.body.innerHTML = '<form><label for="f">Username</label><input id="f" type="text"></form>';
    const { value: sent, vault, target } = await sanitizeField('person@example.com');
    expect(sent).toMatchObject({ kind: 'placeholder', entity: 'USERNAME' });
    const ref = (sent as { ref: string }).ref;
    const resolved = resolveRehydration(vault, defaultPolicy, ref, { originKey: 'origin:test', confirmed: true, targetNode: target });
    expect(resolved).toEqual({ ok: true, value: 'person@example.com' });
  });

  it('a visible "Email" label outranks autocomplete="username" (the password-manager idiom)', () => {
    document.body.innerHTML = '<form><label for="f">Email</label><input id="f" type="email" autocomplete="username"></form>';
    expect(classifyFieldSemantics(field())?.entity).toBe('EMAIL');
  });

  it('a combined "Email / Mobile Number" label lets the value choose between its own two types', async () => {
    document.body.innerHTML = '<form><label for="f">Email / Mobile Number</label><input id="f" type="text"></form>';
    expect((await sanitizeField('9876543210')).value).toMatchObject({ entity: 'PHONE' });
    expect((await sanitizeField('person@example.com')).value).toMatchObject({ entity: 'EMAIL' });
    expect((await sanitizeField('abc')).value).toMatchObject({ entity: 'EMAIL' });
  });

  it('a combined label never lets the value pick a type the label did not name', async () => {
    document.body.innerHTML = '<form><label for="f">Email / Mobile Number</label><input id="f" type="text"></form>';
    const { value: sent, bytes } = await sanitizeField('2345 6789 0124');
    expect(sent).toMatchObject({ kind: 'placeholder', entity: 'EMAIL' });
    expect(bytes).not.toContain('2345 6789 0124');
  });
});

describe('semantic-first redaction — protected fields are never read, whatever their type attribute', () => {
  it('a show-password toggle (type=password → text) keeps the field protected and unread', async () => {
    document.body.innerHTML = '<form><label for="f">Password</label><input id="f" type="password"></form>';
    field().value = 'hunter2-battery';
    field().type = 'text';
    const nodes = extractNodes();
    const node = nodes.find((n) => n.field)!;
    expect(node.field!.valueRead).toBe(false);
    expect(node.field!.value).toBeUndefined();
    const bytes = JSON.stringify(build(new Vault(), nodes));
    expect(bytes).not.toContain('hunter2-battery');
  });

  it('a CSS-masked field keeps its semantic type while staying unread (DigiLocker "Aadhaar or VID Number")', async () => {
    document.body.innerHTML =
      '<form><input id="f" type="tel" placeholder="Aadhaar or VID Number" style="-webkit-text-security: disc"></form>';
    field().value = '2345 6789 0124';
    const { nodes, idOf } = extractGraph();
    const node = nodes.find((n) => n.id === idOf(field()))!;
    expect(node.field!.valueRead).toBe(false);
    expect(node.domSignal).toMatchObject({ entity: 'AADHAAR', valueRead: false });
    const vault = new Vault();
    const ref = vault.mint('AADHAAR', '2345 6789 0124', { originKey: 'origin:test', stepId: 's-0', class: 'CRITICAL' });
    expect(resolveRehydration(vault, defaultPolicy, ref, { originKey: 'origin:test', confirmed: true, targetNode: node })).toMatchObject({ ok: true });
    const sent = build(vault, nodes).nodes.find((n) => n.id === node.id)!.value;
    expect(sent).toEqual({ kind: 'presence', entity: 'AADHAAR', len: 14 });
  });

  it('a nearby caption never re-types a password box', () => {
    document.body.innerHTML = '<form><div><span>Enter your registered email</span><input id="f" type="password"></div></form>';
    expect(extractNodes().find((n) => n.field)!.domSignal).toMatchObject({ entity: 'PASSWORD', valueRead: false });
  });

  it('a masked field with no other semantics is still a PASSWORD', () => {
    document.body.innerHTML = '<form><input id="f" type="text" style="-webkit-text-security: disc"></form>';
    field().value = 'secret';
    expect(extractNodes().find((n) => n.field)!.domSignal).toMatchObject({ entity: 'PASSWORD', valueRead: false });
  });

  it('an OTP field named only by its placeholder is never read', () => {
    document.body.innerHTML = '<form><input id="f" type="text" placeholder="Enter OTP"></form>';
    field().value = '482913';
    const node = extractNodes().find((n) => n.field)!;
    expect(node.field!.valueRead).toBe(false);
    expect(node.domSignal).toMatchObject({ entity: 'OTP', valueRead: false });
  });

  it('"Enter mobile number to receive OTP" fails closed to protected', () => {
    document.body.innerHTML = '<form><label for="f">Enter mobile number to receive OTP</label><input id="f" type="text"></form>';
    field().value = '9876543210';
    const node = extractNodes().find((n) => n.field)!;
    expect(node.field!.valueRead).toBe(false);
  });
});

describe('semantic-first redaction — dynamically generated forms', () => {
  it('a field injected after load, labelled by a later-created caption, is classified on the next extraction', async () => {
    document.body.innerHTML = '<form id="form"></form>';
    const form = document.getElementById('form')!;
    const row = document.createElement('div');
    const caption = document.createElement('div');
    caption.textContent = 'Mobile Number';
    const wrap = document.createElement('div');
    const input = document.createElement('input');
    input.id = 'f';
    wrap.append(input);
    row.append(caption, wrap);
    form.append(row);

    const { value: sent, bytes } = await sanitizeField('abc');
    expect(sent).toMatchObject({ kind: 'placeholder', entity: 'PHONE' });
    expect(bytes).not.toMatch(/"abc"/);
  });

  it('a field whose label is rewritten (framework re-render) follows the new label', async () => {
    document.body.innerHTML = '<form><label id="l" for="f">Remarks</label><input id="f" type="text"></form>';
    expect((await sanitizeField('abc')).value).toEqual({ kind: 'text', text: 'abc' });
    document.getElementById('l')!.textContent = 'Aadhaar Number';
    expect((await sanitizeField('abc')).value).toMatchObject({ kind: 'placeholder', entity: 'AADHAAR' });
  });

  it('a field inside an open shadow root is classified by its shadow-scoped label', async () => {
    document.body.innerHTML = '<form><div id="host"></div></form>';
    const shadow = document.getElementById('host')!.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<label for="f">Email ID</label><input id="f" type="text">';
    const input = shadow.getElementById('f') as HTMLInputElement;
    expect(classifyFieldSemantics(input)?.entity).toBe('EMAIL');
  });
});

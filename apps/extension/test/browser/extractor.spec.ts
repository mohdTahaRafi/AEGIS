import { afterEach, describe, expect, it } from 'vitest';
import { extractScreenGraph } from '../../src/content/screen-graph/extractor';
import { ContainerResolver, createNodeIdentityRegistry } from '../../src/content/screen-graph/identity';

afterEach(() => {
  document.body.innerHTML = '';
});

function extract(html: string) {
  document.body.innerHTML = html;
  return extractScreenGraph(createNodeIdentityRegistry(), new ContainerResolver());
}

describe('extractScreenGraph', () => {
  it('extracts a login-form-shaped page into nodes with real ids, roles, names, boxes and affordances', () => {
    const { nodes } = extract(`
      <form id="login">
        <label for="u">Username</label>
        <input id="u" type="text" name="username" autocomplete="username">
        <label for="p">Password</label>
        <input id="p" type="password" name="password" autocomplete="current-password">
        <button type="submit">Sign in</button>
      </form>
    `);

    // Both the <label> and its <input> are candidate nodes and can share an accessible name
    // (the label's own text content is what it labels) — disambiguate by role.
    const usernameField = nodes.find((n) => n.name === 'Username' && n.role === 'textbox');
    const passwordField = nodes.find((n) => n.name === 'Password' && n.role === 'textbox');
    const submitButton = nodes.find((n) => n.name === 'Sign in' && n.role === 'button');

    expect(usernameField).toBeDefined();
    expect(passwordField).toBeDefined();
    expect(submitButton).toBeDefined();

    expect(usernameField!.id).toMatch(/^n-[0-9a-z]+$/);
    expect(usernameField!.role).toBe('textbox');
    expect(usernameField!.affordances.sort()).toEqual(['click', 'type']);
    expect(usernameField!.box[2]).toBeGreaterThan(0); // width
    expect(usernameField!.box[3]).toBeGreaterThan(0); // height
    expect(usernameField!.field?.inputType).toBe('text');
    expect(usernameField!.field?.autocomplete).toBe('username');

    expect(passwordField!.field?.inputType).toBe('password');
    expect(submitButton!.role).toBe('button');
    expect(submitButton!.affordances).toEqual(['click']);
  });

  it('gives the username and password fields the same container (same form), distinct from a node outside the form', () => {
    const { nodes } = extract(`
      <form id="login">
        <input id="u" type="text">
        <input id="p" type="password">
      </form>
      <button id="outside">Elsewhere</button>
    `);
    const u = nodes.find((n) => n.field?.inputType === 'text')!;
    const p = nodes.find((n) => n.field?.inputType === 'password')!;
    const outside = nodes.find((n) => n.name === 'Elsewhere')!;

    expect(u.container).toBe(p.container);
    expect(u.container).not.toBe(outside.container);
  });

  it('excludes hidden, script/style/template, and extension-owned UI, matching the selection rules', () => {
    const { nodes } = extract(`
      <button id="visible">Click me</button>
      <div id="hidden" style="display:none">Not shown</div>
      <script>/* noop */</script>
      <div data-aegis-ignore><button>Injected</button></div>
    `);
    expect(nodes.some((n) => n.name === 'Click me')).toBe(true);
    expect(nodes.some((n) => n.name === 'Not shown')).toBe(false);
    expect(nodes.some((n) => n.name === 'Injected')).toBe(false);
  });

  it('marks an element under a transparent overlay occluded but still present, not dropped', () => {
    const { nodes } = extract(`
      <div style="position:relative;width:200px;height:100px;">
        <button id="target" style="box-sizing:border-box;margin:0;padding:0;border:0;position:absolute;top:0;left:0;width:200px;height:100px;">Submit</button>
        <div id="overlay" style="position:absolute;top:0;left:0;width:200px;height:100px;"></div>
      </div>
    `);
    const target = nodes.find((n) => n.name === 'Submit');
    expect(target).toBeDefined();
    expect(target!.state.occluded).toBe(true);
  });

  it('assigns every node a unique id', () => {
    const { nodes } = extract(`
      <button>One</button>
      <button>Two</button>
      <button>Three</button>
    `);
    const ids = new Set(nodes.map((n) => n.id));
    expect(ids.size).toBe(nodes.length);
    expect(nodes.length).toBeGreaterThanOrEqual(3);
  });

  it('never lets the content-addressed key leak the recognisable shape of a DOM id into itself', () => {
    const { nodes } = extract('<input id="user-aadhaar-1234" name="aadhaar">');
    const node = nodes[0]!;
    expect(node.key).not.toContain('aadhaar');
    expect(node.key).not.toContain('1234');
  });

  it('reflects live field state: checkbox checked, required, disabled', () => {
    const { nodes } = extract(`
      <input id="c" type="checkbox" checked>
      <input id="r" type="text" required>
      <input id="d" type="text" disabled value="x">
    `);
    const checkbox = nodes.find((n) => n.field?.inputType === 'checkbox')!;
    const required = nodes.find((n) => n.field?.inputType === 'text' && n.state.required)!;
    const disabled = nodes.find((n) => n.field?.inputType === 'text' && n.state.disabled)!;

    expect(checkbox.state.checked).toBe(true);
    expect(required.state.required).toBe(true);
    expect(disabled.state.disabled).toBe(true);
    expect(disabled.state.hasValue).toBe(true);
    expect(disabled.state.valueLen).toBe(1);
  });
});

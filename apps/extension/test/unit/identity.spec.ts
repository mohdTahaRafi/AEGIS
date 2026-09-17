// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  ScreenGraphIndex,
  computeNodeKeyForElement,
  createNodeIdGenerator,
} from '../../src/content/screen-graph/identity';

describe('createNodeIdGenerator', () => {
  it('produces ids matching ^n-[0-9a-z]+$', () => {
    const next = createNodeIdGenerator();
    for (let i = 0; i < 50; i += 1) {
      expect(next()).toMatch(/^n-[0-9a-z]+$/);
    }
  });

  it('never repeats an id across a session', () => {
    const next = createNodeIdGenerator();
    const ids = new Set(Array.from({ length: 500 }, () => next()));
    expect(ids.size).toBe(500);
  });
});

describe('computeNodeKeyForElement — content-addressed identity (design.md §5.6)', () => {
  it('is stable for an identical replacement element at the same structural position', () => {
    document.body.innerHTML = '<form id="f"><input name="user" autocomplete="username"></form>';
    const original = document.querySelector('input') as Element;
    const keyBefore = computeNodeKeyForElement(original, 'f-0', 'textbox', 'Username');

    original.remove();
    document.querySelector('form')!.innerHTML = '<input name="user" autocomplete="username">';
    const replacement = document.querySelector('input') as Element;
    const keyAfter = computeNodeKeyForElement(replacement, 'f-0', 'textbox', 'Username');

    expect(keyAfter).toBe(keyBefore);
  });

  it('differs when the accessible name differs', () => {
    document.body.innerHTML = '<input>';
    const el = document.querySelector('input') as Element;
    const a = computeNodeKeyForElement(el, 'f-0', 'textbox', 'Username');
    const b = computeNodeKeyForElement(el, 'f-0', 'textbox', 'Password');
    expect(a).not.toBe(b);
  });

  it('differs when the form owner differs', () => {
    document.body.innerHTML =
      '<form id="a"><input id="x"></form><form id="b"><input id="y"></form>';
    const x = document.getElementById('x') as Element;
    const y = document.getElementById('y') as Element;
    expect(computeNodeKeyForElement(x, 'f-0', 'textbox', 'Field')).not.toBe(
      computeNodeKeyForElement(y, 'f-0', 'textbox', 'Field'),
    );
  });

  it('never resembles a selector, path, or attribute value (it is an opaque hash)', () => {
    document.body.innerHTML = '<input id="user-aadhaar-1234" name="aadhaar">';
    const el = document.getElementById('user-aadhaar-1234') as Element;
    const key = computeNodeKeyForElement(el, 'f-0', 'textbox', 'Aadhaar number');
    expect(key).toMatch(/^[0-9a-z]+$/);
    expect(key).not.toContain('aadhaar');
    expect(key).not.toContain('1234');
  });
});

describe('ScreenGraphIndex.resolve — resolution ladder (design.md §5.6)', () => {
  function entry(element: Element, key: string, role: string, name: string, formOwnerKey = 'noform') {
    return { element, key, role, name, formOwnerKey };
  }

  it('prefers a connected live WeakRef over any key lookup', () => {
    document.body.innerHTML = '<button id="a">Delete</button>';
    const a = document.getElementById('a') as Element;
    const index = new ScreenGraphIndex();
    index.add(entry(a, 'key-a', 'button', 'Delete'));

    const resolved = index.resolve({
      weakRef: new WeakRef(a),
      key: 'key-a',
      role: 'button',
      name: 'Delete',
      formOwnerKey: 'noform',
    });
    expect(resolved).toBe(a);
  });

  it('falls back to key lookup when the WeakRef target is disconnected', () => {
    document.body.innerHTML = '<button id="a">Delete</button>';
    const original = document.getElementById('a') as Element;
    original.remove();

    document.body.innerHTML = '<button id="b">Delete</button>';
    const replacement = document.getElementById('b') as Element;
    const index = new ScreenGraphIndex();
    index.add(entry(replacement, 'key-shared', 'button', 'Delete'));

    const resolved = index.resolve({
      weakRef: new WeakRef(original),
      key: 'key-shared',
      role: 'button',
      name: 'Delete',
      formOwnerKey: 'noform',
    });
    expect(resolved).toBe(replacement);
  });

  it('rejects, rather than guesses, when the key is ambiguous', () => {
    document.body.innerHTML = '<button id="a">Delete</button><button id="b">Delete</button>';
    const a = document.getElementById('a') as Element;
    const b = document.getElementById('b') as Element;
    const index = new ScreenGraphIndex();
    index.add(entry(a, 'key-dup', 'button', 'Delete'));
    index.add(entry(b, 'key-dup', 'button', 'Delete'));

    const resolved = index.resolve({
      weakRef: null,
      key: 'key-dup',
      role: 'button',
      name: 'Delete',
      formOwnerKey: 'noform',
    });
    expect(resolved).toBeNull();
  });

  it('falls back to fuzzy match (role+name+formOwner) when the key misses', () => {
    document.body.innerHTML = '<button id="a">Delete</button>';
    const a = document.getElementById('a') as Element;
    const index = new ScreenGraphIndex();
    index.add(entry(a, 'key-new', 'button', 'Delete'));

    const resolved = index.resolve({
      weakRef: null,
      key: 'key-stale',
      role: 'button',
      name: 'Delete',
      formOwnerKey: 'noform',
    });
    expect(resolved).toBe(a);
  });

  it('rejects two identical siblings rather than guessing between them', () => {
    document.body.innerHTML = '<button id="a">Delete</button><button id="b">Delete</button>';
    const a = document.getElementById('a') as Element;
    const b = document.getElementById('b') as Element;
    const index = new ScreenGraphIndex();
    index.add(entry(a, 'key-a', 'button', 'Delete'));
    index.add(entry(b, 'key-b', 'button', 'Delete'));

    const resolved = index.resolve({
      weakRef: null,
      key: 'key-neither',
      role: 'button',
      name: 'Delete',
      formOwnerKey: 'noform',
    });
    expect(resolved).toBeNull();
  });

  it('rejects when nothing matches at all', () => {
    const index = new ScreenGraphIndex();
    const resolved = index.resolve({
      weakRef: null,
      key: 'missing',
      role: 'button',
      name: 'Nonexistent',
      formOwnerKey: 'noform',
    });
    expect(resolved).toBeNull();
  });
});

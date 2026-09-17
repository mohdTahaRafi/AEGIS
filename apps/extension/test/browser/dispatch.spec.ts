import { afterEach, describe, expect, it } from 'vitest';
import { dispatchClick, dispatchClickPoint, dispatchScroll, dispatchSelect, dispatchType } from '../../src/content/execute/dispatch';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('dispatchType (design.md §5.9 AC — React-controlled inputs)', () => {
  it('a React-controlled input receives the typed value via the native value setter', () => {
    document.body.innerHTML = '<input id="i" type="text">';
    const input = document.getElementById('i') as HTMLInputElement;

    // Simulate React's controlled-input pattern: it installs its own 'value' property
    // descriptor on the *instance* to intercept a plain `el.value = x` and no-op it (this is
    // exactly why the native setter, called on the prototype, is required).
    const nativeGetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.get!;
    let reactShadowValue = '';
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => reactShadowValue,
      set: () => {
        /* React ignores a direct set outside its own onChange cycle */
      },
    });
    input.addEventListener('input', () => {
      // React's real behaviour: onChange (triggered by the native 'input' event, which reflects
      // the real underlying value the native setter wrote) updates its shadow state.
      reactShadowValue = nativeGetter.call(input);
    });

    dispatchType(input, 'hello', { willMoveFocusNext: false });
    expect(reactShadowValue).toBe('hello');
  });

  it('a plain input receives the typed value and fires input then no change/blur when focus does not move', () => {
    document.body.innerHTML = '<input id="i" type="text">';
    const input = document.getElementById('i') as HTMLInputElement;
    const events: string[] = [];
    input.addEventListener('input', () => events.push('input'));
    input.addEventListener('change', () => events.push('change'));
    input.addEventListener('blur', () => events.push('blur'));

    dispatchType(input, 'abc', { willMoveFocusNext: false });

    expect(input.value).toBe('abc');
    expect(events).toEqual(['input']);
  });

  it('fires change and blur only when the plan says focus moves next', () => {
    document.body.innerHTML = '<input id="i" type="text">';
    const input = document.getElementById('i') as HTMLInputElement;
    const events: string[] = [];
    input.addEventListener('change', () => events.push('change'));
    input.addEventListener('blur', () => events.push('blur'));

    dispatchType(input, 'abc', { willMoveFocusNext: true });

    expect(events).toEqual(['change', 'blur']);
  });

  it('clearFirst empties the field before typing', () => {
    document.body.innerHTML = '<input id="i" type="text" value="old">';
    const input = document.getElementById('i') as HTMLInputElement;
    dispatchType(input, 'new', { clearFirst: true, willMoveFocusNext: false });
    expect(input.value).toBe('new');
  });
});

describe('dispatchSelect (design.md §5.9 AC)', () => {
  it('matches an option by visible text and fires input then change', () => {
    document.body.innerHTML = '<select id="s"><option value="a">Alpha</option><option value="b">Beta</option></select>';
    const select = document.getElementById('s') as HTMLSelectElement;
    const events: string[] = [];
    select.addEventListener('input', () => events.push('input'));
    select.addEventListener('change', () => events.push('change'));

    const result = dispatchSelect(select, 'Beta');
    expect(result).toEqual({ ok: true });
    expect(select.value).toBe('b');
    expect(events).toEqual(['input', 'change']);
  });

  it('rejects when no option matches the given text', () => {
    document.body.innerHTML = '<select id="s"><option value="a">Alpha</option></select>';
    const select = document.getElementById('s') as HTMLSelectElement;
    expect(dispatchSelect(select, 'Nonexistent')).toEqual({ ok: false, reason: 'NODE_UNRESOLVED' });
  });
});

describe('dispatchClick (design.md §5.9 AC)', () => {
  it('clicks a visible in-viewport element without needing to scroll', () => {
    document.body.innerHTML = '<button id="b" style="position:fixed;top:10px;left:10px;width:100px;height:30px;">Go</button>';
    const button = document.getElementById('b')!;
    let clicked = false;
    button.addEventListener('click', () => {
      clicked = true;
    });
    const result = dispatchClick(button, () => true);
    expect(result).toEqual({ ok: true });
    expect(clicked).toBe(true);
  });

  it('rejects with HIT_TEST_FAILED when the re-validation after scroll fails', () => {
    document.body.innerHTML = '<button id="b" style="position:fixed;top:10px;left:10px;width:100px;height:30px;">Go</button>';
    const button = document.getElementById('b')!;
    let clicked = false;
    button.addEventListener('click', () => {
      clicked = true;
    });
    const result = dispatchClick(button, () => false);
    expect(result).toEqual({ ok: false, reason: 'HIT_TEST_FAILED' });
    expect(clicked).toBe(false);
  });
});

describe('dispatchClickPoint', () => {
  it('clicks whatever is actually at the given point', () => {
    document.body.innerHTML = '<button id="b" style="position:fixed;top:10px;left:10px;width:100px;height:30px;">Go</button>';
    const button = document.getElementById('b')!;
    let clicked = false;
    button.addEventListener('click', () => {
      clicked = true;
    });
    const result = dispatchClickPoint(50, 25);
    expect(result).toEqual({ ok: true });
    expect(clicked).toBe(true);
  });
});

describe('dispatchScroll (design.md §5.9 AC — awaits scrollend)', () => {
  it('scrolls the window and resolves once scrollend fires', async () => {
    document.body.innerHTML = '<div style="height:3000px;"></div>';
    const before = window.scrollY;
    await dispatchScroll(window, 'down', 'small', 1000);
    expect(window.scrollY).toBeGreaterThan(before);
  });
});

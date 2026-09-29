// press_key / hover / double_click in a real browser: the page's own handlers see the events, and
// the browser default a synthetic key event would not trigger (submit, focus move, delete) happens.

import { afterEach, describe, expect, it } from 'vitest';
import { dispatchClick } from '../../src/content/execute/dispatch';
import { dispatchDoubleClick, dispatchHover, dispatchPressKey } from '../../src/content/execute/keys';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('dispatchPressKey', () => {
  it('Enter in a search field submits its form, and the page sees keydown first', () => {
    document.body.innerHTML = '<form id="f"><input id="q" type="search"></form>';
    const form = document.getElementById('f') as HTMLFormElement;
    const seen: string[] = [];
    document.getElementById('q')!.addEventListener('keydown', (e) => seen.push(`keydown ${e.key}`));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      seen.push('submit');
    });
    dispatchPressKey('Enter', document.getElementById('q'));
    expect(seen).toEqual(['keydown Enter', 'submit']);
  });

  it('a page handler that prevents the default keeps the form from submitting', () => {
    document.body.innerHTML = '<form id="f"><input id="q"></form>';
    let submitted = false;
    document.getElementById('f')!.addEventListener('submit', (e) => {
      e.preventDefault();
      submitted = true;
    });
    document.getElementById('q')!.addEventListener('keydown', (e) => e.preventDefault());
    dispatchPressKey('Enter', document.getElementById('q'));
    expect(submitted).toBe(false);
  });

  it('Enter on a button activates it', () => {
    document.body.innerHTML = '<button id="b">Go</button>';
    let clicked = 0;
    document.getElementById('b')!.addEventListener('click', () => clicked++);
    dispatchPressKey('Enter', document.getElementById('b'));
    expect(clicked).toBe(1);
  });

  it('Tab moves focus to the next focusable element', () => {
    document.body.innerHTML = '<input id="a"><a href="#x" id="link">x</a><button id="b">b</button>';
    dispatchPressKey('Tab', document.getElementById('a'));
    expect(document.activeElement?.id).toBe('link');
  });

  it('Backspace deletes the character before the caret, with no node given (the focused field)', () => {
    document.body.innerHTML = '<input id="i" value="abc">';
    const input = document.getElementById('i') as HTMLInputElement;
    input.focus();
    input.setSelectionRange(3, 3);
    dispatchPressKey('Backspace', null);
    expect(input.value).toBe('ab');
  });

  it('PageDown on the page scrolls the window', () => {
    document.body.innerHTML = '<div style="height:5000px">tall</div>';
    window.scrollTo(0, 0);
    dispatchPressKey('PageDown', null);
    expect(window.scrollY).toBeGreaterThan(0);
  });
});

describe('dispatchHover / dispatchDoubleClick', () => {
  it('hover fires mouseenter and mouseover, which open hover menus', () => {
    document.body.innerHTML = '<div id="m" style="width:100px;height:40px">Menu</div>';
    const seen: string[] = [];
    const menu = document.getElementById('m')!;
    menu.addEventListener('mouseenter', () => seen.push('mouseenter'));
    menu.addEventListener('mouseover', () => seen.push('mouseover'));
    dispatchHover(menu);
    expect(seen).toEqual(['mouseover', 'mouseenter']);
  });

  it('double_click gives two clicks then dblclick', () => {
    document.body.innerHTML = '<button id="b" style="width:80px;height:30px">Cell</button>';
    const seen: string[] = [];
    const cell = document.getElementById('b')!;
    for (const t of ['click', 'dblclick']) cell.addEventListener(t, () => seen.push(t));
    expect(dispatchDoubleClick(cell, (el) => dispatchClick(el, () => true))).toEqual({ ok: true });
    expect(seen).toEqual(['click', 'click', 'dblclick']);
  });
});

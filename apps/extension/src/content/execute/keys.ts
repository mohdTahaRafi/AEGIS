// press_key, hover and double_click. A synthetic KeyboardEvent never triggers the browser's own
// default action (Enter does not submit, Tab does not move focus, PageDown does not scroll), so
// after dispatching keydown/keyup — which is what the page's own handlers listen to — the default
// action is performed here, unless a handler called preventDefault(). Values are never read: text
// edits go through execCommand on the focused field (the same path a user's key press takes).

import type { PressKey } from '../../shared/messages';

const KEY_CODES: Record<PressKey, { key: string; code: string; keyCode: number }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
};

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', '']);

function isTextField(el: Element): boolean {
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(el.type);
  return el instanceof HTMLElement && el.isContentEditable;
}

function isActivatable(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLButtonElement || el instanceof HTMLAnchorElement || el.tagName === 'SUMMARY') return true;
  if (el instanceof HTMLInputElement) return ['button', 'submit', 'reset', 'checkbox', 'radio', 'image'].includes(el.type);
  return ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'option'].includes(el.getAttribute('role') ?? '');
}

const TABBABLE = 'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]';

function nextTabbable(from: Element | null): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (el) => el.tabIndex >= 0 && !(el as HTMLInputElement).disabled && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden',
  );
  if (all.length === 0) return null;
  const at = from ? all.indexOf(from as HTMLElement) : -1;
  return all[(at + 1) % all.length] ?? null;
}

function scrollPage(key: PressKey): void {
  const line = 40;
  const page = window.innerHeight * 0.9;
  const by: Partial<Record<PressKey, number>> = { ArrowUp: -line, ArrowDown: line, PageUp: -page, PageDown: page, Space: page };
  if (key === 'Home') window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  else if (key === 'End') window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' as ScrollBehavior });
  else if (key === 'ArrowLeft' || key === 'ArrowRight') window.scrollBy({ left: key === 'ArrowLeft' ? -line : line, behavior: 'instant' as ScrollBehavior });
  else if (by[key] !== undefined) window.scrollBy({ top: by[key], behavior: 'instant' as ScrollBehavior });
}

function defaultAction(key: PressKey, el: Element): void {
  const text = isTextField(el);
  switch (key) {
    case 'Enter':
      if (el instanceof HTMLTextAreaElement) document.execCommand('insertText', false, '\n');
      else if (el instanceof HTMLElement && el.isContentEditable) document.execCommand('insertLineBreak');
      else if (el instanceof HTMLInputElement && text) el.form?.requestSubmit();
      else if (isActivatable(el)) el.click();
      return;
    case 'Space':
      if (text) document.execCommand('insertText', false, ' ');
      else if (isActivatable(el)) el.click();
      else scrollPage(key);
      return;
    case 'Tab':
      nextTabbable(el === document.body ? null : el)?.focus();
      return;
    case 'Backspace':
    case 'Delete':
      if (text) document.execCommand(key === 'Backspace' ? 'delete' : 'forwardDelete');
      return;
    case 'Escape':
      return;
    default:
      if (!text) scrollPage(key);
  }
}

/** Focuses `target` (when given), sends keydown → keyup to what has focus, then the default action. */
export function dispatchPressKey(key: PressKey, target: Element | null): { ok: true } {
  if (target instanceof HTMLElement && document.activeElement !== target) target.focus();
  const el = document.activeElement ?? document.body;
  const { key: keyName, code, keyCode } = KEY_CODES[key];
  const init = { key: keyName, code, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true };
  const proceed = el.dispatchEvent(new KeyboardEvent('keydown', init));
  if (proceed && keyName.length === 1) el.dispatchEvent(new KeyboardEvent('keypress', { ...init, charCode: keyCode }));
  if (proceed) defaultAction(key, el);
  el.dispatchEvent(new KeyboardEvent('keyup', init));
  return { ok: true };
}

function center(el: Element): { x: number; y: number } {
  const box = el.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

/** The pointer entering and resting on `el`: what opens hover menus and tooltips. */
export function dispatchHover(el: Element): { ok: true } {
  if (el.getBoundingClientRect().bottom < 0 || el.getBoundingClientRect().top > window.innerHeight) el.scrollIntoView({ block: 'center' });
  const { x, y } = center(el);
  const bubbling = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
  const direct = { ...bubbling, bubbles: false };
  el.dispatchEvent(new PointerEvent('pointerover', bubbling));
  el.dispatchEvent(new PointerEvent('pointerenter', direct));
  el.dispatchEvent(new MouseEvent('mouseover', bubbling));
  el.dispatchEvent(new MouseEvent('mouseenter', direct));
  el.dispatchEvent(new PointerEvent('pointermove', bubbling));
  el.dispatchEvent(new MouseEvent('mousemove', bubbling));
  return { ok: true };
}

/** Two clicks, then `dblclick` — the sequence a real double click produces. */
export function dispatchDoubleClick(el: Element, click: (el: Element) => { ok: true } | { ok: false; reason: 'HIT_TEST_FAILED' }): { ok: true } | { ok: false; reason: 'HIT_TEST_FAILED' } {
  const first = click(el);
  if (!first.ok) return first;
  const second = click(el);
  if (!second.ok) return second;
  const { x, y } = center(el);
  el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, detail: 2, view: window }));
  return { ok: true };
}

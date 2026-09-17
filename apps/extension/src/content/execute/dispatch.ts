// design.md §5.9 (T-2.21) — synthetic event dispatch sequences. No chrome.debugger/CDP
// (architecture §5.4 rejects it for its permission and trust surface): every action is a real,
// spec-shaped DOM event sequence dispatched from the isolated world. The native value setter is
// required for React-style controlled inputs, which ignore a plain `el.value = x` — React installs
// its own property descriptor on the instance, so writing through the *prototype's* setter is what
// bypasses that and still fires React's synthetic `onChange`.

function dispatchPointerSequence(el: Element, x: number, y: number): void {
  const common = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
  el.dispatchEvent(new PointerEvent('pointerdown', common));
  el.dispatchEvent(new MouseEvent('mousedown', common));
  el.dispatchEvent(new PointerEvent('pointerup', common));
  el.dispatchEvent(new MouseEvent('mouseup', common));
  el.dispatchEvent(new MouseEvent('click', common));
}

function isInViewport(el: Element): boolean {
  const box = el.getBoundingClientRect();
  return box.top >= 0 && box.left >= 0 && box.bottom <= window.innerHeight && box.right <= window.innerWidth;
}

function centerOf(el: Element): { x: number; y: number } {
  const box = el.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

/**
 * `scrollIntoView` if needed, then **re-run the hit test** before clicking — design.md is explicit
 * that this happens after any scroll, because scrolling can itself bring a new element (or an
 * overlay) to the same point.
 */
export function dispatchClick(el: Element, revalidateHitTest: (el: Element) => boolean): { ok: true } | { ok: false; reason: 'HIT_TEST_FAILED' } {
  if (!isInViewport(el)) {
    el.scrollIntoView({ block: 'center' });
  }
  if (!revalidateHitTest(el)) return { ok: false, reason: 'HIT_TEST_FAILED' };
  const { x, y } = centerOf(el);
  dispatchPointerSequence(el, x, y);
  return { ok: true };
}

/** Only after the host has already shown the user this point (design.md §5.9) — this function
 * trusts its caller for that; it performs the hit test and pointer sequence, nothing more. */
export function dispatchClickPoint(x: number, y: number): { ok: true } | { ok: false; reason: 'HIT_TEST_FAILED' } {
  const el = document.elementFromPoint(x, y);
  if (!el) return { ok: false, reason: 'HIT_TEST_FAILED' };
  dispatchPointerSequence(el, x, y);
  return { ok: true };
}

type Typeable = HTMLInputElement | HTMLTextAreaElement;

function isTypeable(el: Element): el is Typeable {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

function nativeValueSetter(el: Typeable): (value: string) => void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  return (value: string) => {
    if (setter) setter.call(el, value);
    else el.value = value;
  };
}

export function dispatchType(
  el: Element,
  text: string,
  options: { clearFirst?: boolean; willMoveFocusNext: boolean },
): { ok: true } | { ok: false; reason: 'DISABLED' } {
  if (!isTypeable(el)) return { ok: false, reason: 'DISABLED' };
  el.focus();
  const setValue = nativeValueSetter(el);

  if (options.clearFirst && el.value.length > 0) {
    el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'deleteContentBackward' }));
    setValue('');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
  }

  const base = options.clearFirst ? '' : el.value;
  el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
  setValue(base + text);
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));

  if (options.willMoveFocusNext) {
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }
  return { ok: true };
}

export function dispatchSelect(el: Element, optionText: string): { ok: true } | { ok: false; reason: 'NODE_UNRESOLVED' } {
  if (!(el instanceof HTMLSelectElement)) return { ok: false, reason: 'NODE_UNRESOLVED' };
  const option = Array.from(el.options).find((o) => o.text.trim() === optionText.trim());
  if (!option) return { ok: false, reason: 'NODE_UNRESOLVED' };
  el.value = option.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
}

function amountPx(amount: 'small' | 'page' | 'end' | undefined): number {
  if (amount === 'page') return window.innerHeight;
  if (amount === 'end') return Number.MAX_SAFE_INTEGER;
  return 120;
}

/** `scrollBy`, then await `scrollend` (design.md §5.5/§5.9 — not a bare `scroll` event; T-2.13's
 * observer fix applies here too), bounded by `timeoutMs` so a page that never settles cannot hang
 * a step. */
export function dispatchScroll(
  target: Element | Window,
  direction: 'up' | 'down' | 'left' | 'right',
  amount: 'small' | 'page' | 'end' | undefined,
  timeoutMs = 1000,
): Promise<void> {
  const px = amountPx(amount);
  const dx = direction === 'left' ? -px : direction === 'right' ? px : 0;
  const dy = direction === 'up' ? -px : direction === 'down' ? px : 0;

  return new Promise((resolve) => {
    let settled = false;
    const eventTarget: EventTarget = target;

    function finish(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      eventTarget.removeEventListener('scrollend', finish);
      resolve();
    }

    const timer = setTimeout(finish, timeoutMs);
    eventTarget.addEventListener('scrollend', finish);
    target.scrollBy({ left: dx, top: dy, behavior: 'instant' as ScrollBehavior });
  });
}

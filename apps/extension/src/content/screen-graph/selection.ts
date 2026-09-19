// design.md §5.2 — node selection. Decides which elements are candidates for the screen graph at
// all; visibility (visibility.ts) then decides which candidates survive.

import { computeRole } from './roles';
import { isCaptchaElement } from '../detect/captcha';

/** Marks an element (and its subtree) as the extension's own injected UI — never a candidate. */
export const AEGIS_IGNORE_ATTR = 'data-aegis-ignore';

const EXCLUDED_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE']);
const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);
// T-4.x/T-6.5/T-6.6, found while driving the ablation runner (T-6.9/T-6.10) against a real
// corpus fixture, not assumed from reading the code: `roles.ts`'s `computeRole` routes IMG/
// CANVAS/VIDEO to `role: 'img'` specifically so Channel V (design.md §6.4) picks them up — but
// design.md §5.2's own node-selection criteria (interactive/landmark/heading/label/text-bearing-
// block) were written in Phase 2, before that routing existed, and never extended to include
// them. A bare `<canvas>`/`<video>`/`<img>` with no onclick/tabindex/pointer-cursor and no text
// children (media elements never have any) satisfied NONE of §5.2's categories, so it was never
// selected as a node at all — `roles.ts`'s overload was unreachable on any such element, and
// with it, the whole vision pipeline (face detection since Phase 4, OCR since Phase 6) never ran
// on real pages that don't happen to also make the element interactive some other way. `[A]`:
// design.md doesn't explicitly extend §5.2 to media elements, but its own architecture and every
// phase since 4 clearly intend for them to reach Channel V — recorded here per CLAUDE.md rule 1
// rather than silently assumed; see docs/HISTORY.md for the fuller account.
const MEDIA_TAGS = new Set(['IMG', 'CANVAS', 'VIDEO']);
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'combobox', 'listbox', 'textbox', 'slider', 'searchbox', 'spinbutton',
]);
const LANDMARK_ROLES = new Set([
  'banner', 'navigation', 'main', 'complementary', 'contentinfo', 'search', 'form', 'region',
]);
// display values that make an element a plausible "text-bearing block" (design.md §5.2 [TD]).
const BLOCK_DISPLAYS = new Set(['block', 'list-item', 'table-cell', 'table-caption', 'flex', 'grid']);

function hasDirectNonWhitespaceText(el: Element): boolean {
  return Array.from(el.childNodes).some(
    (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim().length > 0,
  );
}

function isTextBearingBlock(el: Element): boolean {
  if (!hasDirectNonWhitespaceText(el)) return false;
  return BLOCK_DISPLAYS.has(getComputedStyle(el).display);
}

function hasClickAffordanceHeuristic(el: Element): boolean {
  if (el.hasAttribute('onclick')) return true;
  const tabindex = el.getAttribute('tabindex');
  if (tabindex !== null && Number(tabindex) >= 0) return true;
  return getComputedStyle(el).cursor === 'pointer';
}

/**
 * design.md §5.2: interactive elements/roles, landmarks, headings, labels, and text-bearing block
 * elements are candidates. `script`/`style`/`template` and the extension's own UI never are.
 * Visibility (§5.3) is checked separately — this function only asks "is this the *kind* of thing
 * the screen graph should ever carry".
 */
export function isCandidateNode(el: Element): boolean {
  if (EXCLUDED_TAGS.has(el.tagName)) return false;
  if (el.closest(`[${AEGIS_IGNORE_ATTR}]`)) return false;

  if (INTERACTIVE_TAGS.has(el.tagName)) return true;
  if (el.tagName === 'LABEL') return true;
  if (MEDIA_TAGS.has(el.tagName)) return true;
  // T-6.13 (FR-8): a real reCAPTCHA/hCaptcha container/iframe has no click affordance style, no
  // direct text child and no landmark role of its own by default — the same reachability gap
  // MEDIA_TAGS above exists to close, for the same reason (nothing in §5.2's original criteria
  // was ever written with a structural, non-text, non-interactive-by-CSS widget in mind).
  if (isCaptchaElement(el)) return true;

  const role = computeRole(el);
  if (INTERACTIVE_ROLES.has(role)) return true;
  if (LANDMARK_ROLES.has(role)) return true;
  if (role === 'heading') return true;

  if (hasClickAffordanceHeuristic(el)) return true;

  return isTextBearingBlock(el);
}

export type Affordance = 'click' | 'type' | 'select' | 'toggle' | 'scroll';

const TOGGLE_ROLES = new Set(['checkbox', 'radio', 'switch']);
const CLICK_ROLES = new Set(['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', ...TOGGLE_ROLES]);

function isScrollable(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const overflowY = getComputedStyle(el).overflowY;
  return (overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
}

/**
 * design.md §3.1's `affordances` field. Text-like inputs/textareas/contenteditable get both
 * `click` (to focus) and `type`, matching design.md §4.3's worked example
 * (`["click","type"]` on a textbox node, `["click"]` on a button).
 */
export function computeAffordances(el: Element, role: string): Affordance[] {
  const affordances = new Set<Affordance>();

  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox' || el.type === 'radio') {
      affordances.add('click');
      affordances.add('toggle');
    } else if (['button', 'submit', 'reset', 'image', 'file', 'color', 'range'].includes(el.type)) {
      affordances.add('click');
    } else if (el.type !== 'hidden') {
      affordances.add('click');
      affordances.add('type');
    }
  } else if (el instanceof HTMLTextAreaElement) {
    affordances.add('click');
    affordances.add('type');
  } else if (el instanceof HTMLSelectElement) {
    affordances.add('click');
    affordances.add('select');
  } else if (el.tagName === 'A' || el.tagName === 'BUTTON') {
    affordances.add('click');
  } else if (CLICK_ROLES.has(role)) {
    affordances.add('click');
    if (TOGGLE_ROLES.has(role)) affordances.add('toggle');
  } else if (el instanceof HTMLElement && el.isContentEditable) {
    affordances.add('click');
    affordances.add('type');
  }

  if (isScrollable(el)) affordances.add('scroll');

  return Array.from(affordances);
}

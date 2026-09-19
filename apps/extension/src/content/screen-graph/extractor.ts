// design.md §3.1 — ties roles/selection/accname/identity/visibility/geometry into the actual
// screen graph. Needs real layout throughout, so this is exercised in test/browser/, not jsdom.

import { computeAccessibleName } from './accname';
import { classifyChannelD, type ChannelDSignal } from '../detect/channel-d';
import { classifyProtected } from '../detect/protected';
import { isCaptchaElement } from '../detect/captcha';
import { boxFromRect, readBoxesInOnePass, type Box } from './geometry';
import { ContainerResolver, computeNodeKeyForElement, type NodeIdentityRegistry } from './identity';
import { computeRole } from './roles';
import { computeAffordances, isCandidateNode, type Affordance } from './selection';
import { collectAllElements } from './shadow-dom';
import { computeStackingRank, isOccluded, isVisible, type ViewportExtent } from './visibility';

export interface RawScreenNodeState {
  focused: boolean;
  disabled: boolean;
  readonly: boolean;
  required: boolean;
  checked?: boolean;
  expanded?: boolean;
  selected?: boolean;
  hasValue: boolean;
  valueLen: number;
  occluded: boolean;
  /** T-6.7: real, from `VolatilityTracker.isVolatile()` — the caller passes a resolved predicate
   * into `extractScreenGraph`'s options (see `ExtractOptions.isVolatile`). Defaults to always
   * `false` when no predicate is supplied (every pre-T-6.7 caller/test is unaffected). */
  volatile: boolean;
}

export interface RawScreenNodeField {
  inputType: string;
  autocomplete?: string;
  inputmode?: string;
  maskedCss: boolean;
  /**
   * T-3.9 / FR-23: false for PASSWORD, OTP, CARD_NUMBER, CARD_CVV and SECRET fields — for those,
   * `computeField` below returns before any expression touches `.value` as a string. `hasValue`/
   * `valueLen` are still reported (they come from `computeState`, which reads `.value.length`,
   * never the string itself).
   */
  valueRead: boolean;
  value?: string;
}

/** design.md §3.1's `RawScreenNode`, content-script-internal shape (not the wire schema). */
export interface RawScreenNode {
  id: string;
  /** Content-addressed re-resolution handle. Never sent (phase_2_spine.md §3.2). */
  key: string;
  frame: string;
  role: string;
  name: string;
  box: Box;
  z: number;
  state: RawScreenNodeState;
  affordances: Affordance[];
  field?: RawScreenNodeField;
  container: string;
  /** Ids of child TextRun nodes. Always [] until text-run extraction is built. */
  textRuns: string[];
  /** design.md §6.1's Channel D signal (T-3.8), or `undefined` if no row matches. */
  domSignal?: ChannelDSignal;
  /** The element's real tag — see `WireScreenNode.tagName`'s doc comment (T-6.5/6.6) for why this
   * travels alongside the `role: 'img'` overload rather than replacing it. */
  tagName: string;
}

export interface ExtractedGraph {
  nodes: RawScreenNode[];
  /**
   * `id` → live element, internal-only (never serialized — `toWireNode` strips it along with
   * `key`). Lets a caller (pre-flight re-resolution, T-2.20) go from an action's `node` id back
   * to the actual DOM element without a second DOM walk.
   */
  elements: Map<string, Element>;
}

export interface ExtractOptions {
  root?: ParentNode;
  /** Defaults to `f-0` until T-2.14 (child-frame sub-graphs) exists. */
  frame?: string;
  viewport?: ViewportExtent;
  /** T-6.7: bound to a live `VolatilityTracker.isVolatile(el, now)`. Defaults to "never
   * volatile" — every pre-T-6.7 caller/test is unaffected. */
  isVolatile?: (el: Element) => boolean;
}

function computeHasValue(el: Element): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value.length > 0;
  if (el instanceof HTMLSelectElement) return el.value.length > 0;
  return false;
}

function computeValueLen(el: Element): number {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value.length;
  if (el instanceof HTMLSelectElement) return el.value.length;
  return 0;
}

function computeState(el: Element, occluded: boolean, isVolatile: (el: Element) => boolean): RawScreenNodeState {
  const state: RawScreenNodeState = {
    focused: document.activeElement === el,
    disabled: (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el instanceof HTMLButtonElement) && el.disabled,
    readonly: (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.readOnly,
    required: (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) && el.required,
    hasValue: computeHasValue(el),
    valueLen: computeValueLen(el),
    occluded,
    volatile: isVolatile(el),
  };
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
    state.checked = el.checked;
  }
  if (el.hasAttribute('aria-expanded')) {
    state.expanded = el.getAttribute('aria-expanded') === 'true';
  }
  if (el.hasAttribute('aria-selected')) {
    state.selected = el.getAttribute('aria-selected') === 'true';
  }
  return state;
}

function isMaskedCss(el: Element): boolean {
  const value = getComputedStyle(el).getPropertyValue('-webkit-text-security');
  return value !== '' && value !== 'none';
}

/**
 * T-3.9 — the classification happens BEFORE any value access, and the protected branch has no
 * expression that touches `.value` as a string at all: it returns immediately with `value`
 * omitted. This is a deletion, not a check — there is no `if (protected) { don't send value }`
 * downstream that a refactor could bypass, because the string is never bound to a variable here
 * in the first place.
 */
function computeField(el: Element): RawScreenNodeField | undefined {
  if (el instanceof HTMLInputElement) {
    const protectedClass = classifyProtected(el);
    const autocomplete = el.getAttribute('autocomplete') ?? undefined;
    const inputmode = el.getAttribute('inputmode') ?? undefined;
    const maskedCss = isMaskedCss(el);
    if (protectedClass) {
      return { inputType: el.type, autocomplete, inputmode, maskedCss, valueRead: false };
    }
    return { inputType: el.type, autocomplete, inputmode, maskedCss, valueRead: true, value: el.value };
  }
  if (el instanceof HTMLTextAreaElement) {
    const protectedClass = classifyProtected(el);
    const autocomplete = el.getAttribute('autocomplete') ?? undefined;
    if (protectedClass) {
      return { inputType: 'textarea', autocomplete, maskedCss: false, valueRead: false };
    }
    return { inputType: 'textarea', autocomplete, maskedCss: false, valueRead: true, value: el.value };
  }
  return undefined;
}

function defaultViewport(): ViewportExtent {
  return { width: window.innerWidth, height: window.innerHeight, verticalMarginPx: window.innerHeight };
}

/**
 * Builds the current screen graph: selects candidates (§5.2), reads their geometry in one pass
 * (T-2.10), keeps only visible ones (§5.3), and computes identity/role/name/affordances/state for
 * each. `identity` and `containerResolver` are passed in rather than module globals so a caller
 * (the content-script port) controls their session lifetime — `identity` in particular must
 * survive across calls for ids to stay stable (see `NodeIdentityRegistry`'s doc comment).
 *
 * Two passes over the candidates: the first computes each one's `key` (needed to know whether a
 * key is ambiguous this pass, which `identity.resolveId` depends on); the second assigns ids and
 * builds the final nodes. Geometry is still read in one uninterrupted pass either way (T-2.10).
 */
export function extractScreenGraph(
  identity: NodeIdentityRegistry,
  containerResolver: ContainerResolver,
  options: ExtractOptions = {},
): ExtractedGraph {
  const root = options.root ?? document.body;
  const frame = options.frame ?? 'f-0';
  const viewport = options.viewport ?? defaultViewport();
  const isVolatile = options.isVolatile ?? (() => false);

  const candidates = collectAllElements(root).filter(isCandidateNode);
  const boxes = readBoxesInOnePass(candidates);

  interface Pending {
    el: Element;
    box: DOMRectReadOnly;
    role: string;
    name: string;
    key: string;
    occluded: boolean;
  }

  const pending: Pending[] = [];
  for (const el of candidates) {
    const box = boxes.get(el);
    if (!box || !isVisible(el, box, viewport)) continue;
    const role = computeRole(el);
    const name = computeAccessibleName(el);
    pending.push({
      el,
      box,
      role,
      name,
      key: computeNodeKeyForElement(el, frame, role, name),
      occluded: isOccluded(el, box),
    });
  }

  identity.prepare(pending.map((p) => p.key));

  const elements = new Map<string, Element>();
  const nodes: RawScreenNode[] = pending.map((p) => {
    const id = identity.resolveId(p.el, p.key);
    elements.set(id, p.el);
    return {
      id,
      key: p.key,
      frame,
      role: p.role,
      name: p.name,
      box: boxFromRect(p.box),
      z: computeStackingRank(p.el, p.box),
      state: computeState(p.el, p.occluded, isVolatile),
      affordances: computeAffordances(p.el, p.role),
      field: computeField(p.el),
      container: containerResolver.resolve(p.el),
      textRuns: [],
      // T-6.13 (FR-8): `classifyChannelD` only ever looks at form fields (a CAPTCHA widget is a
      // plain div/iframe, never one), so a real widget falls through to this check — a non-form
      // Channel D signal with no "value" to read, the same `presence`-only shape PASSWORD/OTP
      // already use for the identical reason (nothing to mint, only something to flag).
      domSignal: classifyChannelD(p.el, p.name) ?? (isCaptchaElement(p.el) ? { entity: 'CAPTCHA', score: 1.0, valueRead: false } : undefined),
      tagName: p.el.tagName,
    };
  });

  return { nodes, elements };
}

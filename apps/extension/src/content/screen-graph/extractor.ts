// design.md §3.1 — ties roles/selection/accname/identity/visibility/geometry into the actual
// screen graph. Needs real layout throughout, so this is exercised in test/browser/, not jsdom.

import { computeAccessibleName } from './accname';
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
  /** Always false until T-2.13's mutation-rate tracking exists. */
  volatile: boolean;
}

export interface RawScreenNodeField {
  inputType: string;
  autocomplete?: string;
  inputmode?: string;
  maskedCss: boolean;
  /**
   * Always true until Phase 3's T-3.9 (phase_2_spine.md §14 forward dependency): that task
   * inverts this for PASSWORD/OTP/CARD_NUMBER/CARD_CVV/SECRET fields, which must never have a
   * code path that reads `.value`.
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

function computeState(el: Element, occluded: boolean): RawScreenNodeState {
  const state: RawScreenNodeState = {
    focused: document.activeElement === el,
    disabled: (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el instanceof HTMLButtonElement) && el.disabled,
    readonly: (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.readOnly,
    required: (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) && el.required,
    hasValue: computeHasValue(el),
    valueLen: computeValueLen(el),
    occluded,
    volatile: false,
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

function computeField(el: Element): RawScreenNodeField | undefined {
  if (el instanceof HTMLInputElement) {
    return {
      inputType: el.type,
      autocomplete: el.getAttribute('autocomplete') ?? undefined,
      inputmode: el.getAttribute('inputmode') ?? undefined,
      maskedCss: isMaskedCss(el),
      valueRead: true,
      value: el.value,
    };
  }
  if (el instanceof HTMLTextAreaElement) {
    return {
      inputType: 'textarea',
      autocomplete: el.getAttribute('autocomplete') ?? undefined,
      maskedCss: false,
      valueRead: true,
      value: el.value,
    };
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
      state: computeState(p.el, p.occluded),
      affordances: computeAffordances(p.el, p.role),
      field: computeField(p.el),
      container: containerResolver.resolve(p.el),
      textRuns: [],
    };
  });

  return { nodes, elements };
}

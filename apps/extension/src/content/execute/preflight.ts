// design.md §5.9 / phase_2_spine.md §5.2 (T-2.20) — pre-flight facets, run synchronously
// immediately before dispatch. "Identity only chooses which element to check; it never
// authorises an action" (§5.3): resolution finds a candidate, the facets below decide.
//
// Position/size drift is not a hard reject here (design.md: "Repair if hit-test passes") — this
// layer always dispatches against the element's *live* geometry, not a remembered box, so minor
// drift is absorbed automatically. The mandatory, hard-reject facet is the hit test: it is the
// clickjacking guard, and no amount of "close enough" geometry substitutes for actually asking
// the page what is at that point.

import { computeAccessibleName } from '../screen-graph/accname';
import type { ExtractedGraph } from '../screen-graph/extractor';
import { ContainerResolver, ScreenGraphIndex, computeFormOwnerKey } from '../screen-graph/identity';
import { computeRole } from '../screen-graph/roles';
import type { PreflightFailureReason, WireAction, WireActionExpect } from '../../shared/messages';

export type PreflightResult = { ok: true; element: Element } | { ok: false; reason: PreflightFailureReason };

interface RememberedNode {
  element: Element;
  key: string;
  role: string;
  name: string;
  formOwnerKey: string;
  container: string;
}

/**
 * The persistent half of design.md §5.6's resolution ladder: a `WeakRef`-backed memory of every
 * id this session has ever assigned, so a target that has scrolled out of the *visible* graph (and
 * so is absent from the latest extraction) can still be found. `observe()` must be called after
 * every extraction pass to keep this current; `resolve()` is what pre-flight calls per action.
 */
export class NodeResolutionRegistry {
  private readonly remembered = new Map<string, RememberedNode>();

  observe(graph: ExtractedGraph, containerResolver: ContainerResolver): ScreenGraphIndex {
    const index = new ScreenGraphIndex();
    for (const node of graph.nodes) {
      const element = graph.elements.get(node.id);
      if (!element) continue;
      const formOwnerKey = computeFormOwnerKey(element);
      index.add({ element, key: node.key, role: node.role, name: node.name, formOwnerKey });
      this.remembered.set(node.id, {
        element,
        key: node.key,
        role: node.role,
        name: node.name,
        formOwnerKey,
        container: containerResolver.resolve(element),
      });
    }
    return index;
  }

  resolve(id: string, index: ScreenGraphIndex): Element | null {
    const remembered = this.remembered.get(id);
    if (!remembered) return null;
    return index.resolve({
      weakRef: new WeakRef(remembered.element),
      key: remembered.key,
      role: remembered.role,
      name: remembered.name,
      formOwnerKey: remembered.formOwnerKey,
    });
  }

  containerAtAssignment(id: string): string | null {
    return this.remembered.get(id)?.container ?? null;
  }
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

function isTextEntry(el: Element): boolean {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable);
}

function isDisabledForType(el: Element): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.disabled || el.readOnly;
  if (el instanceof HTMLSelectElement) return el.disabled;
  return false;
}

/** design.md §5.9: only pointer-dispatching ops need the clickjacking hit test. `type`/`select`
 * act via focus + programmatic value changes, never a blind coordinate click. */
const HIT_TEST_OPS = new Set(['click', 'click_point', 'double_click', 'hover']);

export function passesHitTest(element: Element): boolean {
  const box = element.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return false;
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const topmost = document.elementFromPoint(x, y);
  return topmost !== null && element.contains(topmost);
}

function checkExpect(element: Element, expect: WireActionExpect | undefined): PreflightFailureReason | null {
  if (!expect) return null;
  if (expect.role && computeRole(element) !== expect.role) return 'FACET_ROLE';
  if (expect.name && normalizeName(computeAccessibleName(element)) !== normalizeName(expect.name)) return 'FACET_NAME';
  return null;
}

export function runPreflight(
  action: WireAction,
  registry: NodeResolutionRegistry,
  index: ScreenGraphIndex,
  containerResolver: ContainerResolver,
  isVolatile: (el: Element) => boolean = () => false,
): PreflightResult {
  if (action.op === 'click_point') {
    // No node id to resolve — the host already showed the user this point (design.md §5.9).
    const topmost = document.elementFromPoint(action.x, action.y);
    if (!topmost) return { ok: false, reason: 'HIT_TEST_FAILED' };
    return { ok: true, element: topmost };
  }

  if (action.op === 'press_key') {
    // No node: the key goes to whatever has focus (the field just typed into, typically).
    if (!action.node) return { ok: true, element: document.activeElement ?? document.body };
    const element = registry.resolve(action.node, index);
    if (!element) return { ok: false, reason: 'NODE_UNRESOLVED' };
    return { ok: true, element };
  }

  if (action.op === 'scroll') {
    // No id at all means "scroll the window" — represented by the scrolling element itself so
    // callers always get a real `Element` back, never a special-cased null.
    if (!action.node) return { ok: true, element: document.documentElement };
    const element = registry.resolve(action.node, index);
    if (!element) return { ok: false, reason: 'NODE_UNRESOLVED' };
    return { ok: true, element };
  }

  const element = registry.resolve(action.node, index);
  if (!element) return { ok: false, reason: 'NODE_UNRESOLVED' };

  // design.md §5.5: "cannot be a plan target without a fresh observation." Checked against the
  // element's LIVE state, right here, immediately before dispatch — the same "no TOCTOU gap"
  // reasoning this file's own top comment gives for running facets synchronously right before
  // dispatch, not against a possibly-stale plan-time snapshot.
  // Typing into a text field or editor is exempt: a live editor (Gmail's message body keeps
  // changing its own attributes while open) is still exactly the field the plan named, and typing
  // does not depend on content that moved. Clicks and selects on a volatile node stay refused.
  if (isVolatile(element) && !(action.op === 'type' && isTextEntry(element))) return { ok: false, reason: 'NODE_VOLATILE' };

  const expectFailure = checkExpect(element, 'expect' in action ? action.expect : undefined);
  if (expectFailure) return { ok: false, reason: expectFailure };

  if (HIT_TEST_OPS.has(action.op) && !passesHitTest(element)) {
    return { ok: false, reason: 'HIT_TEST_FAILED' };
  }

  if (action.op === 'type' && isDisabledForType(element)) {
    return { ok: false, reason: 'DISABLED' };
  }

  const assignedContainer = registry.containerAtAssignment(action.node);
  if (assignedContainer !== null && containerResolver.resolve(element) !== assignedContainer) {
    return { ok: false, reason: 'CONTAINER_MISMATCH' };
  }

  return { ok: true, element };
}

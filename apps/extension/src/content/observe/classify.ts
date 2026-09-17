// design.md §5.5 — mutation classification. Cosmetic mutations never touch an epoch; semantic
// mutations bump their container's epoch; privacy-relevant mutations bump the global
// `privacyEpoch`, which forces re-analysis before the next send (Phase 3 makes that load-bearing).

import { computeRole } from '../screen-graph/roles';
import { computeAffordances } from '../screen-graph/selection';

export type MutationClass = 'cosmetic' | 'semantic' | 'privacy-relevant';

const PRIVACY_RELEVANT_TAGS = new Set(['IMG', 'CANVAS', 'IFRAME', 'VIDEO', 'INPUT']);
const SEMANTIC_ATTRIBUTES = new Set(['role', 'disabled', 'aria-disabled', 'aria-hidden', 'hidden']);
const PRIVACY_RELEVANT_ATTRIBUTES = new Set(['type', 'autocomplete']);
// design.md §5.5: "style-only changes, transform-only animation" are cosmetic. Anything else in
// a style attribute (display, visibility, position, size, ...) can change what's selectable or
// visible, so it counts as semantic.
const COSMETIC_STYLE_PROPERTIES = new Set(['transform', 'opacity', 'filter', 'color', 'background-color', 'text-decoration-color']);

function parseInlineStyle(value: string | null): Map<string, string> {
  const props = new Map<string, string>();
  if (!value) return props;
  for (const declaration of value.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon === -1) continue;
    const name = declaration.slice(0, colon).trim().toLowerCase();
    const val = declaration.slice(colon + 1).trim();
    if (name) props.set(name, val);
  }
  return props;
}

function changedStyleProperties(oldValue: string | null, newValue: string | null): string[] {
  const before = parseInlineStyle(oldValue);
  const after = parseInlineStyle(newValue);
  const changed = new Set<string>();
  for (const [name, value] of after) {
    if (before.get(name) !== value) changed.add(name);
  }
  for (const name of before.keys()) {
    if (!after.has(name)) changed.add(name);
  }
  return Array.from(changed);
}

function classifyStyleChange(el: Element, oldValue: string | null): MutationClass {
  const changed = changedStyleProperties(oldValue, el.getAttribute('style'));
  if (changed.length === 0) return 'cosmetic';
  const allCosmetic = changed.every((prop) => COSMETIC_STYLE_PROPERTIES.has(prop));
  return allCosmetic ? 'cosmetic' : 'semantic';
}

function hasAffordance(el: Element): boolean {
  const role = computeRole(el);
  return computeAffordances(el, role).length > 0;
}

function classifyAddedOrRemovedNode(node: Node): MutationClass {
  if (node.nodeType !== Node.ELEMENT_NODE) return 'cosmetic';
  const el = node as Element;
  if (PRIVACY_RELEVANT_TAGS.has(el.tagName)) return 'privacy-relevant';
  if (hasAffordance(el)) return 'semantic';
  return 'cosmetic';
}

function worst(classes: MutationClass[]): MutationClass {
  if (classes.includes('privacy-relevant')) return 'privacy-relevant';
  if (classes.includes('semantic')) return 'semantic';
  return 'cosmetic';
}

/** design.md §5.5's three-way mutation classification. */
export function classifyMutation(record: MutationRecord): MutationClass {
  if (record.type === 'characterData') return 'cosmetic';

  if (record.type === 'attributes') {
    const name = record.attributeName ?? '';
    if (PRIVACY_RELEVANT_ATTRIBUTES.has(name)) return 'privacy-relevant';
    if (name === 'style') return classifyStyleChange(record.target as Element, record.oldValue);
    if (SEMANTIC_ATTRIBUTES.has(name)) return 'semantic';
    return 'semantic';
  }

  if (record.type === 'childList') {
    const nodes = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
    if (nodes.length === 0) return 'cosmetic';
    return worst(nodes.map(classifyAddedOrRemovedNode));
  }

  return 'cosmetic';
}

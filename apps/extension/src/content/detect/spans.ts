// design.md §5.5/§3.2 (textRunId) — free text on the page, distinct from field values, that
// Channel T and NER need to scan (e.g. "Aadhaar on record: 2345 6789 0123" is prose, not a form
// field). [A]: a full stability-container/change-classification system (design.md §5.5) is not
// built this phase — each leaf text-bearing element gets one run, keyed by a WeakMap so ids are
// stable across extraction passes for as long as the element itself survives, which is sufficient
// for Channel T/NER (they don't need cross-step coreference the way interactive nodes do).

import { boxFromRect, type Box } from '../screen-graph/geometry';
import { isVisible, type ViewportExtent } from '../screen-graph/visibility';

export interface TextRun {
  id: string;
  box: Box;
  text: string;
  /** T-6.7: true when this run's own element is mutating fast enough to be marked volatile
   * (design.md §5.5) — a clock/counter `<span>` is exactly this case, and is a `TextRun`, not a
   * graph node (no interactive role/affordance), so `WireScreenNodeState.volatile` alone can't
   * cover it. Absent/`false` when no volatility predicate is supplied — every pre-T-6.7
   * caller/test is unaffected. */
  volatile?: boolean;
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'INPUT', 'TEXTAREA', 'SELECT']);

const idByElement = new WeakMap<Element, string>();
let counter = 0;

function idFor(el: Element): string {
  const existing = idByElement.get(el);
  if (existing) return existing;
  const id = `t-${(counter++).toString(36)}`;
  idByElement.set(el, id);
  return id;
}

function directText(el: Element): string {
  let text = '';
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? '';
  }
  return text.trim();
}

function isLeafTextContainer(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName)) return false;
  if (directText(el).length === 0) return false;
  // A "leaf" text container: none of its element children also carry direct text of their own
  // (that child would get its own run instead, avoiding double-counting nested text).
  for (const child of el.children) {
    if (directText(child).length > 0) return false;
  }
  return true;
}

/** Collects one `TextRun` per leaf text-bearing element under `root`, visible and not inside a
 * form control (field values are handled by the node graph, not here). `isVolatile` (T-6.7)
 * defaults to "never volatile" — every pre-T-6.7 caller/test is unaffected. */
export function extractTextRuns(root: ParentNode, viewport: ViewportExtent, isVolatile: (el: Element) => boolean = () => false): TextRun[] {
  const runs: TextRun[] = [];
  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_ELEMENT);
  let node = walker.currentNode as Element | null;
  while (node) {
    if (node.nodeType === Node.ELEMENT_NODE && isLeafTextContainer(node)) {
      const box = node.getBoundingClientRect();
      if (isVisible(node, box, viewport)) {
        runs.push({ id: idFor(node), box: boxFromRect(box), text: directText(node), volatile: isVolatile(node) || undefined });
      }
    }
    node = walker.nextNode() as Element | null;
  }
  return runs;
}

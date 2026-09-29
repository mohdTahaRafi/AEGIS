// design.md §5.5/§3.2 (textRunId) — free text on the page, distinct from field values, that
// Channel T and NER need to scan (e.g. "Aadhaar on record: 2345 6789 0123" is prose, not a form
// field). [A]: a full stability-container/change-classification system (design.md §5.5) is not
// built this phase — each leaf text-bearing element gets one run, keyed by a WeakMap so ids are
// stable across extraction passes for as long as the element itself survives, which is sufficient
// for Channel T/NER (they don't need cross-step coreference the way interactive nodes do).

import type { EntityType } from '@aegis/recognizers';
import { fieldEntitiesFromText } from '@aegis/recognizers';
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
  /** Entity named by this run's DOM-associated label, if any (see `labelEntityFor`). */
  labelEntity?: EntityType;
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'INPUT', 'TEXTAREA', 'SELECT']);

const idByElement = new WeakMap<Element, string>();
const elementById = new Map<string, WeakRef<Element>>();
let counter = 0;

function idFor(el: Element): string {
  const existing = idByElement.get(el);
  if (existing) return existing;
  const id = `t-${(counter++).toString(36)}`;
  idByElement.set(el, id);
  elementById.set(id, new WeakRef(el));
  return id;
}

type SpanBox = [number, number, number, number];

// Inline (phrasing) elements: a paragraph whose text is interleaved with these (`text <a>link</a>
// text`) is read as ONE run of its whole text. Before, only its innermost pieces were runs, so the
// paragraph's own words were never scanned by the recognizers, and the whole-frame OCR saw those
// lines as text the DOM had not read.
const INLINE_TAGS = new Set([
  'A', 'ABBR', 'B', 'BDI', 'BDO', 'BR', 'CITE', 'CODE', 'DATA', 'DFN', 'EM', 'I', 'KBD', 'MARK', 'Q', 'S', 'SAMP',
  'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR', 'WBR', 'FONT', 'IMG', 'LABEL',
]);

/** Text nodes making up an element's run, in order: its own text nodes, or — for inline mixed
 * content — every text node under it (never inside script/style/form controls). */
function runTextNodes(el: Element, whole: boolean): Text[] {
  if (!whole) return Array.from(el.childNodes).filter((n): n is Text => n.nodeType === Node.TEXT_NODE);
  const out: Text[] = [];
  const walk = (node: Node): void => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) out.push(child as Text);
      else if (child.nodeType === Node.ELEMENT_NODE && !SKIP_TAGS.has((child as Element).tagName)) walk(child);
    }
  };
  walk(el);
  return out;
}

/** Elements whose run covers their whole inline subtree. */
const wholeRuns = new WeakSet<Element>();

/** Where characters `[start, end)` of a run's text (as the host saw it: trimmed, with `⟪`/`⟫`
 * escaped to two characters each) sit on screen — one rectangle per line they wrap onto. Lets a
 * value inside a paragraph be blacked out on its own instead of the whole paragraph. Empty when
 * the run's element is gone or the span no longer matches its text. Geometry only. */
export function measureRunSpan(runId: string, start: number, end: number): SpanBox[] {
  const el = elementById.get(runId)?.deref();
  if (!el || !el.isConnected || end <= start) return [];
  const texts: { node: Text; from: number }[] = [];
  let raw = '';
  for (const node of runTextNodes(el, wholeRuns.has(el))) {
    texts.push({ node, from: raw.length });
    raw += node.textContent ?? '';
  }
  const lead = raw.length - raw.trimStart().length;
  // Escaped index → raw index: every delimiter is two characters in the escaped text.
  const rawIndex = (escaped: number): number => {
    let e = 0;
    let r = lead;
    while (e < escaped && r < raw.length) {
      e += raw[r] === '⟪' || raw[r] === '⟫' ? 2 : 1;
      r++;
    }
    return r;
  };
  const rawStart = rawIndex(start);
  const rawEnd = rawIndex(end);
  const locate = (at: number): { node: Text; offset: number } | null => {
    for (let i = texts.length - 1; i >= 0; i--) {
      const t = texts[i]!;
      if (at >= t.from) return { node: t.node, offset: Math.min(at - t.from, t.node.length) };
    }
    return null;
  };
  const a = locate(rawStart);
  const b = locate(rawEnd);
  if (!a || !b) return [];
  const range = document.createRange();
  try {
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
  } catch {
    return [];
  }
  const out: SpanBox[] = [];
  for (const r of Array.from(range.getClientRects())) {
    if (r.width < 1 || r.height < 1) continue;
    out.push([r.left, r.top, r.width, r.height]);
  }
  return out;
}

function directText(el: Element): string {
  let text = '';
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? '';
  }
  return text.trim();
}

/** `text <a>link</a> text`: the element's own text and its children's text are one inline run. */
function isInlineMixed(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName) || directText(el).length === 0 || el.children.length === 0) return false;
  let childText = false;
  for (const child of el.querySelectorAll('*')) {
    if (!INLINE_TAGS.has(child.tagName)) return false;
    if (!childText && directText(child).length > 0) childText = true;
  }
  return childText;
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

// A label is a short caption; a labelled value is a short datum. Longer text on either side is
// prose, where a label-word nearby says nothing about what the text is.
const MAX_LABEL_CHARS = 40;
const MAX_VALUE_CHARS = 80;
const LABEL_TAGS = new Set(['LABEL', 'DT', 'TH', 'B', 'STRONG']);

function textOf(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function tableHeaderFor(cell: HTMLTableCellElement): string {
  for (let prev = cell.previousElementSibling; prev; prev = prev.previousElementSibling) {
    if (prev.tagName === 'TH') return textOf(prev);
  }
  const table = cell.closest('table');
  const headerRow = table?.tHead?.rows[0] ?? null;
  const header = headerRow?.cells[cell.cellIndex];
  return header && header !== cell ? textOf(header) : '';
}

/** The caption the page binds to a value element: `aria-labelledby`, the `<dt>` of its `<dd>`,
 * the row/column `<th>` of its `<td>`, or an immediately preceding label-like sibling
 * (`<label>`/`<dt>`/`<th>`/`<b>`/`<strong>`, or any short text ending in a colon). Structure
 * only — nearby text that is not bound to the element does not count. */
function labelTextFor(el: Element): string {
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => textOf(el.ownerDocument.getElementById(id)))
      .join(' ')
      .trim();
    if (text) return text;
  }
  const cell = el.closest('dd, td');
  if (cell?.tagName === 'DD') {
    let prev = cell.previousElementSibling;
    while (prev?.tagName === 'DD') prev = prev.previousElementSibling;
    if (prev?.tagName === 'DT') return textOf(prev);
  } else if (cell?.tagName === 'TD') {
    const header = tableHeaderFor(cell as HTMLTableCellElement);
    if (header) return header;
  }
  const prev = el.previousElementSibling;
  if (prev) {
    const text = textOf(prev);
    if (LABEL_TAGS.has(prev.tagName) || /[:：]$/.test(text)) return text;
  }
  return '';
}

/** Semantic-first, like `field-semantics.ts` for inputs: "Mobile: <anything>" is a PHONE value
 * whatever its format. Only the first entity the label names is used. */
export function labelEntityFor(el: Element, text: string): EntityType | undefined {
  if (LABEL_TAGS.has(el.tagName) || text.length > MAX_VALUE_CHARS) return undefined;
  const label = labelTextFor(el);
  if (!label || label.length > MAX_LABEL_CHARS || label === text) return undefined;
  return fieldEntitiesFromText(label)[0];
}

/** Collects one `TextRun` per leaf text-bearing element under `root`, visible and not inside a
 * form control (field values are handled by the node graph, not here). `isVolatile` (T-6.7)
 * defaults to "never volatile" — every pre-T-6.7 caller/test is unaffected. */
export function extractTextRuns(root: ParentNode, viewport: ViewportExtent, isVolatile: (el: Element) => boolean = () => false): TextRun[] {
  if (elementById.size > 20_000) for (const [id, ref] of elementById) if (!ref.deref()?.isConnected) elementById.delete(id);
  const runs: TextRun[] = [];
  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_ELEMENT);
  let node = walker.currentNode as Element | null;
  while (node) {
    let skipSubtree = false;
    if (node.nodeType === Node.ELEMENT_NODE) {
      const whole = isInlineMixed(node);
      if (whole || isLeafTextContainer(node)) {
        const box = node.getBoundingClientRect();
        if (isVisible(node, box, viewport)) {
          if (whole) wholeRuns.add(node);
          const text = runTextNodes(node, whole)
            .map((t) => t.textContent ?? '')
            .join('')
            .trim();
          runs.push({ id: idFor(node), box: boxFromRect(box), text, volatile: isVolatile(node) || undefined, labelEntity: labelEntityFor(node, text) });
        }
        skipSubtree = whole;
      }
    }
    if (skipSubtree) {
      let next: Node | null = walker.nextSibling();
      while (!next && walker.parentNode()) next = walker.nextSibling();
      node = next as Element | null;
    } else {
      node = walker.nextNode() as Element | null;
    }
  }
  return runs;
}

// design.md §5.4 — simplified AccName order. Runs in the content-script context only;
// the returned name is RAW and must be analysed before it ever leaves the device (phase_2_spine.md §3.2).

const TEXT_CONTENT_MAX_LENGTH = 120;
const TEXT_CONTENT_MAX_DEPTH = 10;
const BUTTON_VALUE_INPUT_TYPES = new Set(['button', 'submit', 'reset']);

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function fromLabelledBy(el: Element, visited: Set<Element>): string {
  const attr = el.getAttribute('aria-labelledby');
  if (!attr) return '';
  const root = el.getRootNode() as Document | ShadowRoot;
  const names = attr
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => root.getElementById?.(id))
    .filter((ref): ref is HTMLElement => ref != null)
    .map((ref) => computeAccessibleNameInternal(ref, visited));
  return collapseWhitespace(names.join(' '));
}

function fromAriaLabel(el: Element): string {
  return collapseWhitespace(el.getAttribute('aria-label') ?? '');
}

// A <textarea>'s text content is its prefilled value and a <select>'s is every option, so label
// text must skip nested controls or the name would carry the value itself.
const CONTROL_CONTENT_TAGS = new Set(['TEXTAREA', 'SELECT', 'OPTION', 'SCRIPT', 'STYLE']);

function labelText(label: Element): string {
  const out: string[] = [];
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === child.TEXT_NODE) out.push(child.textContent ?? '');
      else if (child.nodeType === child.ELEMENT_NODE && !CONTROL_CONTENT_TAGS.has((child as Element).tagName)) walk(child);
    }
  };
  walk(label);
  return collapseWhitespace(out.join(' '));
}

function fromAssociatedLabel(el: Element): string {
  if (el.id) {
    const root = el.getRootNode() as Document | ShadowRoot;
    const labels = root.querySelectorAll ? Array.from(root.querySelectorAll('label')) : [];
    const forLabel = labels.find((l) => (l as HTMLLabelElement).htmlFor === el.id);
    if (forLabel) return labelText(forLabel);
  }
  const wrapping = el.closest('label');
  if (wrapping) return labelText(wrapping);
  return '';
}

function fromAltOrTitle(el: Element): string {
  if (el.tagName === 'IMG') {
    const alt = el.getAttribute('alt');
    if (alt != null && alt.trim()) return collapseWhitespace(alt);
  }
  const title = el.getAttribute('title');
  if (title && title.trim()) return collapseWhitespace(title);
  return '';
}

function fromPlaceholder(el: Element): string {
  return collapseWhitespace(el.getAttribute('placeholder') ?? '');
}

function collectText(el: Element, depth: number, out: string[]): void {
  if (depth > TEXT_CONTENT_MAX_DEPTH) return;
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === child.TEXT_NODE) {
      const t = child.textContent ?? '';
      if (t.trim()) out.push(t);
    } else if (child.nodeType === child.ELEMENT_NODE) {
      collectText(child as Element, depth + 1, out);
    }
    if (out.join(' ').length >= TEXT_CONTENT_MAX_LENGTH) return;
  }
}

function fromTextContent(el: Element): string {
  if (CONTROL_CONTENT_TAGS.has(el.tagName)) return '';
  const out: string[] = [];
  collectText(el, 0, out);
  const joined = collapseWhitespace(out.join(' '));
  return joined.slice(0, TEXT_CONTENT_MAX_LENGTH);
}

function fromButtonValue(el: Element): string {
  if (el instanceof HTMLInputElement && BUTTON_VALUE_INPUT_TYPES.has(el.type)) {
    return collapseWhitespace(el.getAttribute('value') ?? '');
  }
  return '';
}

function computeAccessibleNameInternal(el: Element, visited: Set<Element>): string {
  if (visited.has(el)) return '';
  visited.add(el);

  const sources = [
    () => fromLabelledBy(el, visited),
    () => fromAriaLabel(el),
    () => fromAssociatedLabel(el),
    () => fromAltOrTitle(el),
    () => fromPlaceholder(el),
    () => fromTextContent(el),
    () => fromButtonValue(el),
  ];

  for (const source of sources) {
    const name = source();
    if (name) return name;
  }
  return '';
}

/** Computes the raw accessible name of `el`, in AccName precedence order (design.md §5.4). */
export function computeAccessibleName(el: Element): string {
  return computeAccessibleNameInternal(el, new Set());
}

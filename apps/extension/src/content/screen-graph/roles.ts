// design.md §3.1: "role: AriaRole — explicit, or implicit from tag". This is a pragmatic subset of
// the HTML-AAM implicit-role table covering the elements node selection (§5.2) actually needs —
// interactive controls, landmarks, and headings — not a full accessibility-tree implementation.

const SECTIONING_ANCESTORS = 'article, aside, main, nav, section';

function hasAccessibleNameHint(el: Element): boolean {
  return (
    el.hasAttribute('aria-label') ||
    el.hasAttribute('aria-labelledby') ||
    (el.hasAttribute('title') && (el.getAttribute('title') ?? '').trim().length > 0)
  );
}

function implicitInputRole(el: HTMLInputElement): string {
  switch (el.type) {
    case 'checkbox':
      return 'checkbox';
    case 'radio':
      return 'radio';
    case 'range':
      return 'slider';
    case 'button':
    case 'submit':
    case 'reset':
    case 'image':
    case 'file':
    case 'color':
      return 'button';
    case 'hidden':
      return 'none';
    default:
      return 'textbox';
  }
}

function implicitRole(el: Element): string {
  const tag = el.tagName;
  switch (tag) {
    case 'A':
      return el.hasAttribute('href') ? 'link' : 'generic';
    case 'BUTTON':
      return 'button';
    case 'INPUT':
      return implicitInputRole(el as HTMLInputElement);
    case 'SELECT':
      return (el as HTMLSelectElement).multiple ? 'listbox' : 'combobox';
    case 'TEXTAREA':
      return 'textbox';
    case 'NAV':
      return 'navigation';
    case 'MAIN':
      return 'main';
    case 'ASIDE':
      return 'complementary';
    case 'HEADER':
      // Only a landmark when not nested in sectioning content (HTML-AAM).
      return el.closest(SECTIONING_ANCESTORS) ? 'generic' : 'banner';
    case 'FOOTER':
      return el.closest(SECTIONING_ANCESTORS) ? 'generic' : 'contentinfo';
    case 'FORM':
      return 'form';
    case 'SECTION':
      return hasAccessibleNameHint(el) ? 'region' : 'generic';
    case 'ARTICLE':
      return 'article';
    case 'IMG':
      return 'img';
    // [A] Phase 4: CANVAS and VIDEO have no distinguishing implicit ARIA role (both are
    // 'generic'/fallback-content-dependent per HTML-AAM), but Channel V (phase_4_vision.md §4.1)
    // needs to route exactly these element kinds to vision regardless of accessibility semantics.
    // Reusing 'img' is a deliberate, disclosed overload for that routing purpose, not a claim
    // about their actual ARIA role.
    case 'CANVAS':
    case 'VIDEO':
      return 'img';
    case 'H1':
    case 'H2':
    case 'H3':
    case 'H4':
    case 'H5':
    case 'H6':
      return 'heading';
    case 'LI':
      return 'listitem';
    case 'UL':
    case 'OL':
      return 'list';
    case 'TABLE':
      return 'table';
    default:
      return 'generic';
  }
}

/** design.md §3.1: explicit `role` attribute wins; otherwise the implicit role from the tag. */
export function computeRole(el: Element): string {
  const explicit = el.getAttribute('role');
  if (explicit) {
    const [first] = explicit.trim().split(/\s+/);
    if (first) return first;
  }
  return implicitRole(el);
}

// Semantic-first field classification: decides what a form field IS from the evidence the page
// attaches to that specific field — never from its current value. A field labelled "Email ID"
// holding "abc" is still an EMAIL field; a field labelled "Password" is protected even after a
// show-password toggle has made it `type=text`. Value recognizers (host-side Channel T) only
// confirm or pick between this module's alternatives; they cannot make the classification
// disappear.
//
// Association matters: only text bound to the field counts — its own attributes, its <label>s,
// its aria-labelledby targets, and (only when none of those exist) the nearest caption-like text
// preceding it in its own layout cell. A page merely containing the word "email" somewhere does
// nothing. Nothing here reads `.value`.

import type { EntityType } from '@aegis/recognizers';
import { fieldEntitiesFromText, identifierToWords } from '@aegis/recognizers';

export type EvidenceSource =
  | 'input-type'
  | 'autocomplete'
  | 'aria-labelledby'
  | 'aria-label'
  | 'label'
  | 'placeholder'
  | 'title'
  | 'name-id'
  | 'nearby';

// A visible label outranks `autocomplete`: login forms routinely put `autocomplete="username"`
// on a field labelled "Email" (it is what password managers key on), and the user asked that
// label semantics win. Array order breaks score ties.
const SOURCE_WEIGHT: ReadonlyArray<[EvidenceSource, number]> = [
  ['aria-labelledby', 0.92],
  ['aria-label', 0.92],
  ['label', 0.92],
  ['autocomplete', 0.9],
  ['placeholder', 0.85],
  ['input-type', 0.85],
  ['title', 0.8],
  ['name-id', 0.8],
  ['nearby', 0.75],
];
const WEIGHT = new Map(SOURCE_WEIGHT);
const PRECEDENCE = SOURCE_WEIGHT.map(([s]) => s);
const AGREEMENT_BONUS = 0.02;

const PROTECTED_ENTITIES: ReadonlySet<EntityType> = new Set(['PASSWORD', 'OTP', 'CARD_NUMBER', 'CARD_CVV', 'SECRET']);

const AUTOCOMPLETE_ENTITY: Record<string, EntityType> = {
  email: 'EMAIL',
  tel: 'PHONE',
  'tel-national': 'PHONE',
  'tel-local': 'PHONE',
  'street-address': 'ADDRESS',
  'address-line1': 'ADDRESS',
  'address-line2': 'ADDRESS',
  'address-line3': 'ADDRESS',
  'postal-code': 'PIN_CODE',
  bday: 'DOB',
  'bday-day': 'DOB',
  'bday-month': 'DOB',
  'bday-year': 'DOB',
  name: 'PERSON_NAME',
  'given-name': 'PERSON_NAME',
  'additional-name': 'PERSON_NAME',
  'family-name': 'PERSON_NAME',
  username: 'USERNAME',
  'current-password': 'PASSWORD',
  'new-password': 'PASSWORD',
  'one-time-code': 'OTP',
  'cc-number': 'CARD_NUMBER',
  'cc-csc': 'CARD_CVV',
  'cc-exp': 'CARD_EXPIRY',
  'cc-exp-month': 'CARD_EXPIRY',
  'cc-exp-year': 'CARD_EXPIRY',
  'cc-name': 'PERSON_NAME',
  'cc-given-name': 'PERSON_NAME',
  'cc-family-name': 'PERSON_NAME',
};

/** Input types whose value is never free-form entry, so they carry no sensitive-value semantics. */
const NON_ENTRY_INPUT_TYPES = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'hidden', 'range', 'color']);

// Component frameworks nest a field deeply before its caption appears (React Native Web on
// Passport Seva puts "Email ID *" beside the input's 5th wrapper). Depth alone does not decide
// association — the other-field, heading, form-boundary and prose-length stops below do.
const NEARBY_MAX_DEPTH = 8;
const NEARBY_MAX_SIBLINGS = 3;
const CAPTION_MAX_LENGTH = 80;
const TEXT_SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SELECT', 'OPTION', 'TEXTAREA', 'INPUT', 'BUTTON']);
const FORM_CONTROL_SELECTOR = 'input:not([type=hidden]), select, textarea, button';
const NEARBY_STOP_TAGS = new Set(['FORM', 'FIELDSET', 'BODY', 'DIALOG']);
const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LEGEND']);

export interface FieldEvidence {
  entity: EntityType;
  source: EvidenceSource;
}

export interface FieldSemantics {
  entity: EntityType;
  score: number;
  /** Other entities named by the same winning text ("Email / Mobile" → [PHONE] when EMAIL
   * wins), in text order. The host lets a value recognizer pick among `entity` + these. */
  alternatives: EntityType[];
  source: EvidenceSource;
  /** Set when any field-bound evidence names a protected class — the field's value must not be
   * read, whatever `entity` ended up being (fail closed). */
  protectedClass?: Extract<EntityType, 'PASSWORD' | 'OTP' | 'CARD_NUMBER' | 'CARD_CVV' | 'SECRET'>;
}

type TextEntryField = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

export function isTextEntryField(el: Element): el is TextEntryField {
  if (el instanceof HTMLInputElement) return !NON_ENTRY_INPUT_TYPES.has(el.type);
  return el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Visible-ish text of `el`, excluding the contents of nested form controls — a wrapping
 * `<label>` around a `<select>` must not pick up every option, and a textarea's text content is
 * its initial value. */
function captionText(el: Node, out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out;
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const t = child.textContent ?? '';
      if (t.trim()) out.push(t);
    } else if (child.nodeType === Node.ELEMENT_NODE && !TEXT_SKIP_TAGS.has((child as Element).tagName)) {
      captionText(child, out, depth + 1);
    }
  }
  return out;
}

function textOf(el: Node): string {
  return collapse(captionText(el).join(' '));
}

function labelsText(el: TextEntryField): string {
  const labels = el.labels ? Array.from(el.labels) : [];
  return collapse(labels.map((l) => textOf(l)).join(' '));
}

function labelledByText(el: Element): string {
  const ids = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
  if (ids.length === 0) return '';
  const root = el.getRootNode() as Document | ShadowRoot;
  return collapse(
    ids
      .map((id) => root.getElementById?.(id))
      .filter((ref): ref is HTMLElement => ref != null)
      .map((ref) => textOf(ref))
      .join(' '),
  );
}

function isDisplayed(el: Element): boolean {
  const style = getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

/**
 * The caption a sighted user reads as this field's label when the page never marked it up as
 * one: the nearest preceding text in the field's own layout cell, climbing at most
 * NEARBY_MAX_DEPTH wrappers (`<td>Email</td><td><input></td>`, `<div>Email</div><div><input>
 * </div>`, or a caption beside a stack of framework wrappers). Stops — returning nothing — the moment it would cross into another field's territory
 * (a sibling containing a form control), a form/fieldset boundary, or a heading, so an unrelated
 * word elsewhere on the page can never be attributed to this field. Long text is prose, not a
 * caption, and is ignored.
 */
function nearbyCaption(el: Element): string {
  let current: Element = el;
  for (let depth = 0; depth < NEARBY_MAX_DEPTH; depth++) {
    let sibling = current.previousSibling;
    let seen = 0;
    while (sibling && seen < NEARBY_MAX_SIBLINGS) {
      if (sibling.nodeType === Node.TEXT_NODE) {
        const t = collapse(sibling.textContent ?? '');
        if (t) return t.length <= CAPTION_MAX_LENGTH ? t : '';
      } else if (sibling.nodeType === Node.ELEMENT_NODE) {
        const sib = sibling as Element;
        if (HEADING_TAGS.has(sib.tagName)) return '';
        if (sib.matches(FORM_CONTROL_SELECTOR) || sib.querySelector(FORM_CONTROL_SELECTOR)) return '';
        // Another field's own <label> is that field's caption, not this one's.
        if (sib instanceof HTMLLabelElement && sib.control && sib.control !== el) return '';
        if (!TEXT_SKIP_TAGS.has(sib.tagName) && isDisplayed(sib)) {
          const t = textOf(sib);
          if (t) return t.length <= CAPTION_MAX_LENGTH ? t : '';
          seen += 1;
        }
      }
      sibling = sibling.previousSibling;
    }
    const parent = current.parentElement;
    if (!parent || NEARBY_STOP_TAGS.has(parent.tagName)) return '';
    current = parent;
  }
  return '';
}

/** Every piece of field-bound evidence, each tagged with where it came from. */
export function collectFieldEvidence(el: TextEntryField): { evidence: FieldEvidence[]; textEntities: Map<EvidenceSource, EntityType[]> } {
  const evidence: FieldEvidence[] = [];
  const textEntities = new Map<EvidenceSource, EntityType[]>();

  const addText = (source: EvidenceSource, text: string) => {
    const entities = fieldEntitiesFromText(text);
    if (entities.length === 0) return;
    textEntities.set(source, entities);
    for (const entity of entities) evidence.push({ entity, source });
  };

  if (el instanceof HTMLInputElement) {
    if (el.type === 'email') evidence.push({ entity: 'EMAIL', source: 'input-type' });
    if (el.type === 'tel') evidence.push({ entity: 'PHONE', source: 'input-type' });
  }
  const inputMode = (el.getAttribute('inputmode') ?? '').toLowerCase();
  if (inputMode === 'email') evidence.push({ entity: 'EMAIL', source: 'input-type' });
  if (inputMode === 'tel') evidence.push({ entity: 'PHONE', source: 'input-type' });

  const autocompleteTokens = (el.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  for (const token of autocompleteTokens) {
    const entity = AUTOCOMPLETE_ENTITY[token];
    if (entity) evidence.push({ entity, source: 'autocomplete' });
  }

  const labelledBy = labelledByText(el);
  const ariaLabel = collapse(el.getAttribute('aria-label') ?? '');
  const label = labelsText(el);
  addText('aria-labelledby', labelledBy);
  addText('aria-label', ariaLabel);
  addText('label', label);
  addText('placeholder', el.getAttribute('placeholder') ?? '');
  addText('title', el.getAttribute('title') ?? '');
  addText('name-id', identifierToWords(`${el.getAttribute('name') ?? ''} ${el.id}`));

  if (!labelledBy && !ariaLabel && !label) addText('nearby', nearbyCaption(el));

  return { evidence, textEntities };
}

/** Combines evidence per entity: the strongest source's weight, plus a small bonus per extra
 * independent source that agrees. Undefined when nothing bound to the field names a sensitive type. */
export function combineFieldEvidence(evidence: readonly FieldEvidence[], textEntities: ReadonlyMap<EvidenceSource, EntityType[]>): FieldSemantics | undefined {
  if (evidence.length === 0) return undefined;

  const byEntity = new Map<EntityType, Set<EvidenceSource>>();
  for (const e of evidence) {
    const sources = byEntity.get(e.entity) ?? new Set();
    sources.add(e.source);
    byEntity.set(e.entity, sources);
  }

  let best: { entity: EntityType; score: number; source: EvidenceSource; rank: number } | undefined;
  for (const [entity, sources] of byEntity) {
    const ranked = [...sources].sort((a, b) => PRECEDENCE.indexOf(a) - PRECEDENCE.indexOf(b));
    const strongest = ranked[0]!;
    const score = Math.min(1, WEIGHT.get(strongest)! + AGREEMENT_BONUS * (sources.size - 1));
    const rank = PRECEDENCE.indexOf(strongest);
    if (!best || score > best.score || (score === best.score && rank < best.rank)) {
      best = { entity, score, source: strongest, rank };
    }
  }
  if (!best) return undefined;

  const alternatives = (textEntities.get(best.source) ?? []).filter((e) => e !== best!.entity);

  // Fail closed on protected classes: any field-bound evidence naming one protects the value,
  // except a nearby caption that stronger bound evidence already contradicts.
  let protectedClass: FieldSemantics['protectedClass'];
  if (PROTECTED_ENTITIES.has(best.entity)) {
    protectedClass = best.entity as FieldSemantics['protectedClass'];
  } else {
    const hit = evidence.find((e) => PROTECTED_ENTITIES.has(e.entity) && e.source !== 'nearby');
    if (hit) protectedClass = hit.entity as FieldSemantics['protectedClass'];
  }

  return { entity: best.entity, score: best.score, alternatives, source: best.source, protectedClass };
}

export function classifyFieldSemantics(el: Element): FieldSemantics | undefined {
  if (!isTextEntryField(el)) return undefined;
  const { evidence, textEntities } = collectFieldEvidence(el);
  return combineFieldEvidence(evidence, textEntities);
}

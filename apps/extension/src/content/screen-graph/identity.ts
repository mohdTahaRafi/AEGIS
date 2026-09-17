// design.md §5.6 — node identity. `id` crosses the network (opaque, per-session random);
// `key` never does (phase_2_spine.md §3.2: a structural path can itself carry PII).
// Identity only chooses *which* element to check; it never authorises an action — the
// pre-flight facets (§5) are the authority.

import { computeRole } from './roles';

const STRUCTURAL_PATH_MAX_DEPTH = 6;

/** `n-<base36>`, random per session, never a selector or path (phase_2_spine.md §3.2). */
export function createNodeIdGenerator(rng: () => number = Math.random): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    const random = Math.floor(rng() * 0xffffffff).toString(36);
    return `n-${counter.toString(36)}${random}`;
  };
}

function nthOfType(el: Element): number {
  let index = 0;
  let sibling: Element | null = el;
  while (sibling) {
    if (sibling.tagName === el.tagName) index += 1;
    sibling = sibling.previousElementSibling;
  }
  return index;
}

/** Ancestor chain of `${tagName}:${nthOfType}`, bounded to `STRUCTURAL_PATH_MAX_DEPTH` levels. */
export function computeStructuralPath(el: Element): string[] {
  const path: string[] = [];
  let current: Element | null = el;
  for (let depth = 0; depth < STRUCTURAL_PATH_MAX_DEPTH && current; depth += 1) {
    path.push(`${current.tagName}:${nthOfType(current)}`);
    current = current.parentElement;
  }
  return path;
}

/** Stable local identifier for the `<form>` that owns `el`, or `'noform'`. Never sent. */
export function computeFormOwnerKey(el: Element): string {
  const form = el.closest('form');
  if (!form) return 'noform';
  if (form.id) return `form:${form.id}`;
  return `form:${computeStructuralPath(form).join('>')}`;
}

// Small synchronous string hash (FNV-1a, 32-bit). Not security-critical — `key` is a local
// re-resolution handle, not a secret, and this never leaves the device.
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export interface NodeKeyInput {
  frame: string;
  role: string;
  name: string;
  formOwnerKey: string;
  type: string;
  nameAttr: string;
  autocomplete: string;
  structuralPath: string[];
}

/**
 * `key = hash(frame, role, name, structuralPath≤6, formOwnerKey, type, nameAttr, autocomplete)`
 * (design.md §5.6). Content-addressed: an identical replacement element re-derives the same key.
 */
export function computeNodeKey(input: NodeKeyInput): string {
  const parts = [
    input.frame,
    input.role,
    input.name,
    input.structuralPath.join('>'),
    input.formOwnerKey,
    input.type,
    input.nameAttr,
    input.autocomplete,
  ];
  return fnv1a(parts.join(''));
}

export function computeNodeKeyForElement(el: Element, frame: string, role: string, name: string): string {
  const type = el instanceof HTMLInputElement ? el.type : '';
  return computeNodeKey({
    frame,
    role,
    name,
    formOwnerKey: computeFormOwnerKey(el),
    type,
    nameAttr: el.getAttribute('name') ?? '',
    autocomplete: el.getAttribute('autocomplete') ?? '',
    structuralPath: computeStructuralPath(el),
  });
}

/**
 * design.md line 83's "random per session" means assigned *once* per logical node and kept for
 * as long as that node persists — not regenerated on every extraction pass. Without this, a plan
 * referencing `n-7f` from a prior step would never resolve (the id would already be gone), and
 * T-2.16's deltas would have no stable basis to diff against.
 *
 * Stability ladder per pass: same `Element` object (fast path, a `WeakMap`) → same `key` *and*
 * that key was unambiguous both last pass and this one (a React-style re-render that destroys and
 * recreates an identical element) → otherwise a fresh id. An ambiguous key (two simultaneous
 * siblings sharing one key) never reuses an id via the key path — each gets its own on first
 * sight and keeps it via the `WeakMap` from then on. This mirrors `ScreenGraphIndex.resolve`'s
 * "never guess between ambiguous candidates" rule, applied to id assignment instead of resolution.
 */
export interface NodeIdentityRegistry {
  /** Call once per extraction pass with every candidate's key before any `resolveId` call. */
  prepare(keys: readonly string[]): void;
  resolveId(el: Element, key: string): string;
}

export function createNodeIdentityRegistry(rng: () => number = Math.random): NodeIdentityRegistry {
  const generateId = createNodeIdGenerator(rng);
  const idByElement = new WeakMap<Element, string>();
  const idByKey = new Map<string, string>();
  let keyCounts = new Map<string, number>();

  return {
    prepare(keys) {
      keyCounts = new Map();
      for (const key of keys) keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
    },
    resolveId(el, key) {
      const unambiguous = keyCounts.get(key) === 1;
      const existing = idByElement.get(el);
      if (existing) {
        if (unambiguous) idByKey.set(key, existing);
        return existing;
      }
      const id = unambiguous && idByKey.has(key) ? idByKey.get(key)! : generateId();
      idByElement.set(el, id);
      if (unambiguous) idByKey.set(key, id);
      return id;
    },
  };
}

export interface GraphIndexEntry {
  element: Element;
  key: string;
  role: string;
  name: string;
  formOwnerKey: string;
}

/** Index over the current screen graph, used only for re-resolution — never sent. */
export class ScreenGraphIndex {
  private readonly byKey = new Map<string, GraphIndexEntry[]>();
  private readonly entries: GraphIndexEntry[] = [];

  add(entry: GraphIndexEntry): void {
    this.entries.push(entry);
    const bucket = this.byKey.get(entry.key);
    if (bucket) bucket.push(entry);
    else this.byKey.set(entry.key, [entry]);
  }

  /**
   * Resolution ladder (design.md §5.6): live `WeakRef` → key lookup → fuzzy match
   * (role + name + form owner, all required) → reject. Never guesses between ambiguous
   * candidates — an ambiguous key lookup and an ambiguous fuzzy match both reject.
   */
  resolve(target: { weakRef: WeakRef<Element> | null; key: string; role: string; name: string; formOwnerKey: string }): Element | null {
    const live = target.weakRef?.deref();
    if (live && live.isConnected) return live;

    const byKey = this.byKey.get(target.key);
    if (byKey && byKey.length === 1) {
      // Length just checked above: the single element is guaranteed present.
      return byKey[0]!.element;
    }

    const fuzzy = this.entries.filter(
      (e) => e.role === target.role && e.name === target.name && e.formOwnerKey === target.formOwnerKey,
    );
    if (fuzzy.length === 1) {
      return fuzzy[0]!.element;
    }

    return null;
  }
}

const LANDMARK_ROLES = new Set([
  'banner', 'navigation', 'main', 'complementary', 'contentinfo', 'search', 'form', 'region',
]);

function isStabilityContainerCandidate(el: Element): boolean {
  if (el.tagName === 'FORM') return true;
  if (el.getAttribute('role') === 'dialog') return true;
  if (LANDMARK_ROLES.has(computeRole(el))) return true;
  const style = getComputedStyle(el);
  if (style.position === 'fixed') return true;
  if (style.contain !== 'none' && style.contain !== '') return true;
  const contentVisibility = style.getPropertyValue('content-visibility');
  return contentVisibility !== '' && contentVisibility !== 'visible';
}

/**
 * design.md §5.5: the nearest ancestor that is a `<form>`, `[role=dialog]`, landmark, a
 * `position:fixed` element, or one with `contain`/`content-visibility` — memoised in a
 * `WeakMap` per instance, as the design specifies. Needs real computed style, so this is
 * exercised in `test/browser/`, not jsdom.
 */
export class ContainerResolver {
  private readonly ids = new WeakMap<Element, string>();
  private nextId = 0;

  resolve(el: Element): string {
    let current: Element | null = el;
    while (current) {
      const cached = this.ids.get(current);
      if (cached) return cached;
      if (isStabilityContainerCandidate(current)) return this.idFor(current);
      current = current.parentElement;
    }
    return 'root';
  }

  private idFor(el: Element): string {
    const existing = this.ids.get(el);
    if (existing) return existing;
    this.nextId += 1;
    const id = `c-${this.nextId}`;
    this.ids.set(el, id);
    return id;
  }
}

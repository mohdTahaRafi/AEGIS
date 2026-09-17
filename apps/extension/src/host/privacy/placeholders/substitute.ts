// design.md §7.3's `substitute` — text substitution for free-text runs (field values are
// substituted structurally via `NodeValue`, not text splicing; see context/builder.ts). T-3.15.

export interface SpanReplacement {
  span: [number, number];
  entity: string;
  replacement: string; // the ref, or "⟪ENTITY⟫" for a non-resolvable/presence-only item
}

/** Sorts by start, drops fully-contained duplicates (the highest-class one already won during
 * fusion's grouping — by the time this runs there should be no true overlaps left, but this stays
 * defensive rather than assuming it), then splices right-to-left so earlier spans' indices stay
 * valid, then collapses adjacent same-entity refs separated only by whitespace into one. */
export function substitute(text: string, replacements: readonly SpanReplacement[]): string {
  const sorted = [...replacements].sort((a, b) => a.span[0] - b.span[0]);
  const nonOverlapping: SpanReplacement[] = [];
  let lastEnd = -1;
  for (const r of sorted) {
    if (r.span[0] < lastEnd) continue; // overlaps the previous — skip (defensive; see doc comment)
    nonOverlapping.push(r);
    lastEnd = r.span[1];
  }

  let out = text;
  for (let i = nonOverlapping.length - 1; i >= 0; i -= 1) {
    const r = nonOverlapping[i]!;
    out = out.slice(0, r.span[0]) + r.replacement + out.slice(r.span[1]);
  }

  // Collapse "⟪X#1⟫ ⟪X#1⟫" (same entity+ref, separated only by spacing) into one.
  return out.replace(/(⟪[A-Z_]+#\d+⟫)(\s+)\1/g, '$1');
}

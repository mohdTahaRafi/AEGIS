// design.md §7.4 / T-3.16 — if page text already contains the placeholder delimiters, rewrite
// them BEFORE substitution so a hostile page cannot forge a string that looks like a mint. Order
// matters: this must run before `substitute` ever inserts a real placeholder, or a page's forged
// `⟪AADHAAR#2⟫` and a genuine one become indistinguishable in the output.

export function escapePlaceholderDelimiters(text: string): string {
  return text.replace(/⟪/g, '‹‹').replace(/⟫/g, '››');
}

import type { Recognizer, RecognizerMatch } from '../types';

// design.md §6.2 — a VPA looks like an email but its "domain" is a PSP handle with no TLD dot
// (`name@okhdfcbank`, not `name@example.com`) — that absence of a dot is what disambiguates it
// from Channel T's email recognizer, which requires one.
const UPI_RE = /\b([a-zA-Z0-9.\-_]{2,256})@([a-zA-Z]{2,64})\b/g;

// A representative set of real PSP handles (design.md's "handle list as context") — presence in
// this list raises confidence but is not required to match at all.
const KNOWN_HANDLES = new Set([
  'okhdfcbank', 'okaxis', 'oksbi', 'okicici', 'ybl', 'paytm', 'apl', 'ibl', 'axl', 'upi', 'jio',
]);

export const upiRecognizer: Recognizer = {
  id: 'pattern:upi',
  entity: 'UPI_VPA',
  find(text: string): RecognizerMatch[] {
    const matches: RecognizerMatch[] = [];
    for (const m of text.matchAll(UPI_RE)) {
      const handle = m[2]!.toLowerCase();
      // Followed immediately by a dot-TLD → this is an email address, not a VPA (Channel T's
      // email recognizer handles it).
      const after = text.slice(m.index! + m[0].length);
      if (after.startsWith('.')) continue;
      const known = KNOWN_HANDLES.has(handle);
      matches.push({
        entity: 'UPI_VPA',
        start: m.index!,
        end: m.index! + m[0].length,
        matchedText: m[0],
        score: known ? 0.9 : 0.8,
        source: 'pattern:upi',
        valid: true,
      });
    }
    return matches;
  },
};

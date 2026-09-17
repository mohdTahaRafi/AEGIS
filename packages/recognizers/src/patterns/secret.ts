import { normalizeForMatching } from '../normalize';
import type { Recognizer, RecognizerMatch } from '../types';

// design.md §6.2 — high-entropy tokens with known prefixes (API keys, JWT shape, PEM headers).
const KNOWN_PREFIX_RE = /\b(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const PEM_RE = /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g;
// Generic high-entropy run, used only as a last-resort fallback below the entropy threshold.
const GENERIC_TOKEN_RE = /\b[A-Za-z0-9+/_-]{24,}\b/g;

function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const ENTROPY_THRESHOLD = 3.5;

export const secretRecognizer: Recognizer = {
  id: 'pattern:secret',
  entity: 'SECRET',
  find(rawText: string): RecognizerMatch[] {
    const text = normalizeForMatching(rawText);
    const matches: RecognizerMatch[] = [];
    const covered = new Set<number>();

    const emit = (m: RegExpMatchArray, source: string, score: number) => {
      matches.push({
        entity: 'SECRET',
        start: m.index!,
        end: m.index! + m[0].length,
        matchedText: m[0],
        score,
        source,
        valid: true,
      });
      covered.add(m.index!);
    };

    for (const m of text.matchAll(KNOWN_PREFIX_RE)) emit(m, 'pattern:secret-prefix', 0.9);
    for (const m of text.matchAll(JWT_RE)) emit(m, 'pattern:secret-jwt', 0.9);
    for (const m of text.matchAll(PEM_RE)) emit(m, 'pattern:secret-pem', 0.95);

    for (const m of text.matchAll(GENERIC_TOKEN_RE)) {
      if (covered.has(m.index!)) continue;
      const entropy = shannonEntropy(m[0]);
      if (entropy >= ENTROPY_THRESHOLD) emit(m, 'pattern:secret-entropy', 0.85);
    }

    return matches;
  },
};

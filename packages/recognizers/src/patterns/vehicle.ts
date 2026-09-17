import { normalizeForMatching } from '../normalize';
import type { Recognizer, RecognizerMatch } from '../types';

// design.md §6.2 — state code + district + series + number. Small table of real Indian state/UT
// RTO codes (design.md's "state code table") rather than a bare `[A-Z]{2}` (which would collide
// with any two-letter prefix).
const STATE_CODES = new Set([
  'AP', 'AR', 'AS', 'BR', 'CG', 'GA', 'GJ', 'HR', 'HP', 'JH', 'KA', 'KL', 'MP', 'MH', 'MN', 'ML',
  'MZ', 'NL', 'OD', 'PB', 'RJ', 'SK', 'TN', 'TS', 'TR', 'UP', 'UK', 'WB', 'AN', 'CH', 'DN', 'DD',
  'DL', 'JK', 'LA', 'LD', 'PY',
]);

const VEHICLE_RE = /\b([A-Z]{2})[ -]?(\d{1,2})[ -]?([A-Z]{1,2})[ -]?(\d{4})\b/g;

export const vehicleRecognizer: Recognizer = {
  id: 'pattern:vehicle',
  entity: 'VEHICLE_REG',
  find(rawText: string): RecognizerMatch[] {
    const text = normalizeForMatching(rawText);
    const matches: RecognizerMatch[] = [];
    for (const m of text.matchAll(VEHICLE_RE)) {
      if (!STATE_CODES.has(m[1]!)) continue;
      matches.push({
        entity: 'VEHICLE_REG',
        start: m.index!,
        end: m.index! + m[0].length,
        matchedText: m[0],
        score: 0.75,
        source: 'pattern:vehicle-in',
        valid: true,
      });
    }
    return matches;
  },
};

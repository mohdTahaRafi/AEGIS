/**
 * The scanning logic behind check-no-network.ts, extracted as a pure, parameterized function so
 * it can be exercised by a real test (T-1.9) against a scratch directory instead of only ever
 * being run manually against the extension's own source tree.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const NETWORK_PATTERN = /\b(fetch\s*\(|new\s+XMLHttpRequest|new\s+WebSocket)/;
const EXTENSIONS = new Set(['.ts', '.tsx']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(path.extname(full))) out.push(full);
  }
  return out;
}

export interface ScanResult {
  filesScanned: number;
  violations: string[];
}

/**
 * @param roots Directories to walk for .ts/.tsx files.
 * @param allowedPrefixes Absolute path prefixes under which a network call is permitted. Accepts
 *   either a single directory prefix (the original T-1.9 shape — `src/host/egress/`) or an array,
 *   so a second, narrow, exact-file exception can be added without every call site changing shape.
 *   Phase 4 (T-4.2) adds exactly one such exception — `src/perception/runtime/sessions.ts` — see
 *   `check-no-network.ts`'s doc comment on why a model-file integrity fetch is not the kind of
 *   network call this invariant exists to prevent.
 */
export function scanForNetworkCalls(roots: string[], allowedPrefixes: string | readonly string[]): ScanResult {
  const prefixes = Array.isArray(allowedPrefixes) ? allowedPrefixes : [allowedPrefixes as string];
  const files = roots.flatMap((root) => walk(root));
  const violations: string[] = [];

  for (const file of files) {
    if (prefixes.some((p) => file.startsWith(p))) continue;
    const text = readFileSync(file, 'utf8');
    if (NETWORK_PATTERN.test(text)) {
      violations.push(file);
    }
  }

  return { filesScanned: files.length, violations };
}

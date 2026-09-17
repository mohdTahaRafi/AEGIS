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
 * @param allowedPrefix Absolute path prefix under which a network call is permitted.
 */
export function scanForNetworkCalls(roots: string[], allowedPrefix: string): ScanResult {
  const files = roots.flatMap((root) => walk(root));
  const violations: string[] = [];

  for (const file of files) {
    if (file.startsWith(allowedPrefix)) continue;
    const text = readFileSync(file, 'utf8');
    if (NETWORK_PATTERN.test(text)) {
      violations.push(file);
    }
  }

  return { filesScanned: files.length, violations };
}

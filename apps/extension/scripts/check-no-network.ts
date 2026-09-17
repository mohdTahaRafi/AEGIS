/**
 * Build-time proof for CLAUDE.md §3 / AGENTS.md invariant 2: fetch/XHR/WebSocket may only
 * appear under src/host/egress/. Everything else — content script, perception worker, UI,
 * background — must contain no network call.
 *
 * Phase 2 note: until the egress module exists, this script only enforces the negative half
 * (no network code outside the allowed folder); it will additionally require egress/ to exist
 * once F-E06 lands.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, '..', 'src');
const entrypointsDir = path.join(__dirname, '..', 'entrypoints');
const ALLOWED_PREFIX = path.join(srcDir, 'host', 'egress');

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

function main() {
  const files = [...walk(srcDir), ...walk(entrypointsDir)];
  const violations: string[] = [];

  for (const file of files) {
    if (file.startsWith(ALLOWED_PREFIX)) continue;
    const text = readFileSync(file, 'utf8');
    if (NETWORK_PATTERN.test(text)) {
      violations.push(path.relative(process.cwd(), file));
    }
  }

  if (violations.length > 0) {
    console.error('[aegis] Network call found outside src/host/egress/:');
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log(`[aegis] no-network check passed (${files.length} files scanned)`);
}

main();

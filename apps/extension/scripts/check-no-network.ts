/**
 * Build-time proof for CLAUDE.md §3 / AGENTS.md invariant 2: fetch/XHR/WebSocket may only
 * appear under src/host/egress/. Everything else — content script, perception worker, UI,
 * background — must contain no network call.
 *
 * Phase 2 note: until the egress module exists, this script only enforces the negative half
 * (no network code outside the allowed folder); Phase 2's T-2.46 adds the positive half —
 * requiring src/host/egress/ to exist and be the sole caller — once it does.
 *
 * Scanning logic lives in no-network-scan.ts, parameterized so it can be exercised by a real
 * test (test/unit/no-network-scan.test.ts) against a scratch directory rather than only ever
 * being run manually against this project's own source tree (T-1.9).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanForNetworkCalls } from './no-network-scan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, '..', 'src');
const entrypointsDir = path.join(__dirname, '..', 'entrypoints');
const allowedPrefix = path.join(srcDir, 'host', 'egress');

const { filesScanned, violations } = scanForNetworkCalls([srcDir, entrypointsDir], allowedPrefix);

if (violations.length > 0) {
  console.error('[aegis] Network call found outside src/host/egress/:');
  for (const v of violations) console.error(`  - ${path.relative(process.cwd(), v)}`);
  process.exit(1);
}
console.log(`[aegis] no-network check passed (${filesScanned} files scanned)`);

/**
 * Build-time proof for CLAUDE.md §3 / AGENTS.md invariant 2: fetch/XHR/WebSocket may only
 * appear under src/host/egress/. Everything else — content script, perception worker, UI,
 * background — must contain no network call.
 *
 * T-2.46 adds the two things the negative-only scan couldn't catch on its own: that
 * src/host/egress/ actually exists and actually makes a real network call (not vacuously true
 * because the folder is empty or missing), and the CI tripwire that fails the build if
 * guard-stub.ts is still present once the real guard (src/host/privacy/guard/) exists.
 *
 * Scanning logic lives in no-network-scan.ts / guard-stub-check.ts, parameterized so both are
 * exercised by real tests against a scratch directory rather than only ever being run manually
 * against this project's own source tree (T-1.9, T-2.46).
 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEgressFolderRequirement, checkGuardStubTripwire } from './guard-stub-check.js';
import { scanForNetworkCalls } from './no-network-scan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, '..', 'src');
const entrypointsDir = path.join(__dirname, '..', 'entrypoints');
const egressDir = path.join(srcDir, 'host', 'egress');

// Phase 4, T-4.2 — one narrow, disclosed exception (not a directory-wide carve-out): the
// perception worker's model registry (`runtime/sessions.ts`) fetches a model's bytes to compute
// its sha256 BEFORE creating an ONNX Runtime session — the load-side half of the supply-chain
// control architecture §10.2 names (the fetch-side half already runs at build time, in
// `scripts/fetch-models.ts`, which this scanner never touches). This is not the class of network
// call CLAUDE.md's invariant exists to prevent: the request targets a same-origin,
// extension-bundled asset (never a remote host, never page/task data), and nothing is ever sent —
// only received and hashed. Recorded in `docs/DECISIONS.md` and `docs/HISTORY.md` rather than
// silently widened; the exception is the exact file, not `src/perception/**`, so a future network
// call added anywhere else in perception/ still fails this gate.
const modelRegistryFile = path.join(srcDir, 'perception', 'runtime', 'sessions.ts');

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

let failed = false;

const { filesScanned, violations } = scanForNetworkCalls([srcDir, entrypointsDir], [egressDir, modelRegistryFile]);
if (violations.length > 0) {
  failed = true;
  console.error('[aegis] Network call found outside src/host/egress/:');
  for (const v of violations) console.error(`  - ${path.relative(process.cwd(), v)}`);
}

const egressCheck = checkEgressFolderRequirement(egressDir, listFilesRecursive(egressDir).filter((f) => f.endsWith('.ts')));
if (!egressCheck.ok) {
  failed = true;
  console.error(`[aegis] ${egressCheck.reason}`);
}

const guardStubCheck = checkGuardStubTripwire(
  path.join(egressDir, 'guard-stub.ts'),
  path.join(srcDir, 'host', 'privacy', 'guard'),
);
if (!guardStubCheck.ok) {
  failed = true;
  console.error(`[aegis] ${guardStubCheck.reason}`);
}

if (failed) process.exit(1);
console.log(`[aegis] no-network check passed (${filesScanned} files scanned); egress folder and guard-stub tripwire both clean`);

// design.md §18.3, T-6.9's AC: "not reachable from the normal UI; asserted by a build-output
// check on the release build." Same real "build for real, inspect `.output/`" discipline
// `manifest.spec.ts` already uses — a source-level lint proves nothing about what a bundler
// actually decided to keep; only the built artifact does.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');
// The real switch's storage key — deliberately the ONLY marker checked. `currentAblationArm` is
// not used as a marker: `wxt.config.ts` swaps the real module for `ablations.release-stub.ts` on
// a production build, and that stub legitimately shares the same export name (so the dynamic
// import's call site keeps working in every mode) without ever referencing this key.
const ABLATION_MARKER = 'aegis_debug_ablation_arm';

function allJsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) out.push(...allJsFiles(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

function buildAndCollectJs(target: 'chrome' | 'firefox'): string {
  const args = target === 'firefox' ? ['exec', 'wxt', 'build', '-b', 'firefox'] : ['exec', 'wxt', 'build'];
  execFileSync('pnpm', args, { cwd: ROOT, stdio: 'pipe' });
  const outDir = path.join(ROOT, '.output', `${target}-mv3`);
  return allJsFiles(outDir)
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
}

describe('the release build never ships the ablation debug switch (T-6.9 AC)', () => {
  it('the built Chrome bundle contains no trace of the ablation storage key', () => {
    const bundle = buildAndCollectJs('chrome');
    expect(bundle).not.toContain(ABLATION_MARKER);
  }, 30_000);

  it('the built Firefox bundle contains no trace of the ablation storage key', () => {
    const bundle = buildAndCollectJs('firefox');
    expect(bundle).not.toContain(ABLATION_MARKER);
  }, 30_000);
});

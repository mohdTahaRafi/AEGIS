// architecture.md §10.4 (T-2.3) — the manifest must never carry the high-risk permissions the
// architecture explicitly rejects. Reads the *actual built* manifest for both browsers, not the
// wxt.config.ts source, so a WXT default or a browser-specific quirk can't silently slip one in.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');
const FORBIDDEN = ['debugger', 'webRequest', 'history', 'cookies', 'clipboardRead'];

function build(target: 'chrome' | 'firefox'): Record<string, unknown> {
  const args = target === 'firefox' ? ['exec', 'wxt', 'build', '-b', 'firefox'] : ['exec', 'wxt', 'build'];
  execFileSync('pnpm', args, { cwd: ROOT, stdio: 'pipe' });
  const manifestPath = path.join(ROOT, '.output', `${target}-mv3`, 'manifest.json');
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
}

function allPermissionStrings(manifest: Record<string, unknown>): string[] {
  const perms = (manifest.permissions as string[] | undefined) ?? [];
  const optional = (manifest.optional_permissions as string[] | undefined) ?? [];
  return [...perms, ...optional];
}

describe('built manifests (T-2.3 AC)', () => {
  it('the Chrome manifest contains none of the rejected high-risk permissions', () => {
    const manifest = build('chrome');
    const permissions = allPermissionStrings(manifest);
    for (const forbidden of FORBIDDEN) {
      expect(permissions).not.toContain(forbidden);
    }
  }, 30_000);

  it('the Firefox manifest contains none of the rejected high-risk permissions', () => {
    const manifest = build('firefox');
    const permissions = allPermissionStrings(manifest);
    for (const forbidden of FORBIDDEN) {
      expect(permissions).not.toContain(forbidden);
    }
  }, 30_000);

  it('both manifests declare manifest_version 3 (architecture.md §10.3)', () => {
    const chrome = build('chrome');
    const firefox = build('firefox');
    expect(chrome.manifest_version).toBe(3);
    expect(firefox.manifest_version).toBe(3);
  }, 30_000);
});

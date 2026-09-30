// architecture.md §10.4 (T-2.3) — the manifest must never carry the high-risk permissions the
// architecture explicitly rejects. Reads the *actual built* manifest for both browsers, not the
// wxt.config.ts source, so a WXT default or a browser-specific quirk can't silently slip one in.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyBuild } from '../../scripts/verify-release';

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

describe('built Chrome manifest — screenshot capture permission (production vision path)', () => {
  // `tabs.captureVisibleTab` rejects a per-origin host grant (reproduced in Chromium 153: "Either
  // the '<all_urls>' or 'activeTab' permission is required"). Without `activeTab` the production
  // build can never capture, and every step silently degrades to DOM-only.
  it('declares activeTab, requires only the model API as a host, and keeps <all_urls> optional only', () => {
    const manifest = build('chrome');
    expect(manifest.permissions as string[]).toContain('activeTab');
    // The one required host is the model API the user's own key is for (bring your own key).
    expect(manifest.host_permissions).toEqual(['https://api.groq.com/*']);
    expect(manifest.optional_host_permissions).toEqual(['<all_urls>']);
  }, 30_000);

  // `activeTab` is granted only through `action.onClicked` (entrypoints/background.ts), which
  // needs a declared `action` — without the key, `browser.action` does not exist at all.
  it('declares an action, so the toolbar click can reach action.onClicked', () => {
    expect(build('chrome').action).toEqual({ default_title: 'AEGIS' });
  }, 30_000);
});

describe('built manifests — platform shim parity (design.md §14, T-6.1/T-6.2)', () => {
  it('the Firefox manifest carries browser_specific_settings.gecko.id', () => {
    const manifest = build('firefox');
    const bss = manifest.browser_specific_settings as { gecko?: { id?: string } } | undefined;
    expect(bss?.gecko?.id).toBeTruthy();
  }, 30_000);

  it('the Chrome manifest carries no gecko id (Chrome-specific field must not leak across builds)', () => {
    const manifest = build('chrome');
    expect(manifest.browser_specific_settings).toBeUndefined();
  }, 30_000);

  it('Chrome panel host is side_panel; Firefox panel host is sidebar_action', () => {
    const chrome = build('chrome');
    const firefox = build('firefox');
    expect(chrome.side_panel).toBeDefined();
    expect(chrome.sidebar_action).toBeUndefined();
    expect(firefox.sidebar_action).toBeDefined();
    expect(firefox.side_panel).toBeUndefined();
  }, 30_000);

  it('Chrome opts into cross-origin isolation (COEP/COOP) for threaded WASM; Firefox does not', () => {
    const chrome = build('chrome');
    const firefox = build('firefox');
    expect(chrome.cross_origin_embedder_policy).toEqual({ value: 'require-corp' });
    expect(chrome.cross_origin_opener_policy).toEqual({ value: 'same-origin' });
    expect(firefox.cross_origin_embedder_policy).toBeUndefined();
    expect(firefox.cross_origin_opener_policy).toBeUndefined();
  }, 30_000);
});

describe('built release manifest — bring your own key', () => {
  it('limits where extension pages may connect to the extension and the model API', () => {
    const csp = (build('chrome').content_security_policy as { extension_pages: string }).extension_pages;
    expect(csp).toContain("connect-src 'self' https://api.groq.com");
    expect(csp).not.toMatch(/localhost|127\.0\.0\.1|\*/);
  }, 30_000);

  it('ships icons at every store size, and a minimum Chrome version that has the side panel', () => {
    const manifest = build('chrome');
    expect(Object.keys(manifest.icons as object).sort()).toEqual(['128', '16', '32', '48', '96']);
    expect(Number(manifest.minimum_chrome_version)).toBeGreaterThanOrEqual(116);
  }, 30_000);

  it('passes the release gate: pinned models intact, nothing else in models/, no development strings', () => {
    build('chrome');
    expect(verifyBuild(path.join(ROOT, '.output', 'chrome-mv3'))).toEqual([]);
  }, 30_000);
});

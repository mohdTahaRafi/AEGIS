/**
 * T-1.9: automates what was verified manually in Phase 0 — that the no-network scan actually
 * fires on a real violation, not just that it passes on clean code. Runs against a scratch
 * directory (never the project's own source) so it can plant violations freely.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanForNetworkCalls } from '../../scripts/no-network-scan.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'aegis-no-network-scan-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relPath: string, content: string) {
  const full = path.join(root, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

describe('scanForNetworkCalls', () => {
  it('reports zero violations on clean code', () => {
    write('src/content/extractor.ts', 'export const x = 1;');
    write('src/host/controller.ts', 'export function run() { return true; }');

    const result = scanForNetworkCalls([path.join(root, 'src')], path.join(root, 'src', 'host', 'egress'));

    expect(result.violations).toEqual([]);
    expect(result.filesScanned).toBe(2);
  });

  it('flags a fetch() call outside the allowed folder', () => {
    write('src/content/leaky.ts', "export async function bad() { return fetch('https://evil.example'); }");

    const result = scanForNetworkCalls([path.join(root, 'src')], path.join(root, 'src', 'host', 'egress'));

    expect(result.violations).toEqual([path.join(root, 'src', 'content', 'leaky.ts')]);
  });

  it('flags new XMLHttpRequest() and new WebSocket() the same way', () => {
    write('src/content/xhr.ts', 'const x = new XMLHttpRequest();');
    write('src/perception/ws.ts', "const s = new WebSocket('wss://evil.example');");

    const result = scanForNetworkCalls([path.join(root, 'src')], path.join(root, 'src', 'host', 'egress'));

    expect(result.violations.sort()).toEqual(
      [path.join(root, 'src', 'content', 'xhr.ts'), path.join(root, 'src', 'perception', 'ws.ts')].sort(),
    );
  });

  it('allows fetch() inside the allowed prefix', () => {
    write('src/host/egress/client.ts', "export async function send(p: unknown) { return fetch('https://gateway.local', { method: 'POST' }); }");

    const result = scanForNetworkCalls([path.join(root, 'src')], path.join(root, 'src', 'host', 'egress'));

    expect(result.violations).toEqual([]);
    expect(result.filesScanned).toBe(1);
  });

  it('does not flag "prefetch(" as a fetch() call', () => {
    // The pattern's \b word boundary means a word merely containing "fetch" as a substring,
    // immediately followed by "(", is not a false positive — regression guard against
    // over-eager matching that would make the check useless noise.
    write('src/content/prefetch.ts', 'export function prefetch(url: string) { /* not a network call */ }');

    const result = scanForNetworkCalls([path.join(root, 'src')], path.join(root, 'src', 'host', 'egress'));

    expect(result.violations).toEqual([]);
  });

  it('T-4.2: accepts an array of allowed prefixes, allowing an exact-file exception alongside the egress folder', () => {
    write('src/host/egress/client.ts', "fetch('https://gateway.local');");
    write('src/perception/runtime/sessions.ts', "fetch('/models/face.onnx');");

    const result = scanForNetworkCalls(
      [path.join(root, 'src')],
      [path.join(root, 'src', 'host', 'egress'), path.join(root, 'src', 'perception', 'runtime', 'sessions.ts')],
    );

    expect(result.violations).toEqual([]);
  });

  it('T-4.2: the exact-file exception does not widen to the rest of that directory', () => {
    write('src/perception/runtime/sessions.ts', "fetch('/models/face.onnx');");
    write('src/perception/runtime/other.ts', "fetch('https://evil.example');");

    const result = scanForNetworkCalls(
      [path.join(root, 'src')],
      [path.join(root, 'src', 'host', 'egress'), path.join(root, 'src', 'perception', 'runtime', 'sessions.ts')],
    );

    expect(result.violations).toEqual([path.join(root, 'src', 'perception', 'runtime', 'other.ts')]);
  });
});

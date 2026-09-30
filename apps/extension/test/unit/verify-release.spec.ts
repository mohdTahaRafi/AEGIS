import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyBuild } from '../../scripts/verify-release';
import { verifyModels } from '../../scripts/verify-models';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** A minimal but valid release tree; each test breaks one thing. */
function fakeRelease(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'aegis-release-'));
  dirs.push(dir);
  mkdirSync(path.join(dir, 'models'));
  mkdirSync(path.join(dir, 'icons'));
  mkdirSync(path.join(dir, 'assets'));
  writeFileSync(path.join(dir, 'models', 'm.onnx'), 'model-bytes');
  writeFileSync(path.join(dir, 'models', 'models.manifest.json'), JSON.stringify({ models: [{ id: 'm', file: 'm.onnx', sha256: sha('model-bytes'), bytes: 11, source: 'https://x' }] }));
  writeFileSync(path.join(dir, 'icons', '128.png'), 'png');
  writeFileSync(path.join(dir, 'assets', 'ort.wasm'), 'wasm');
  writeFileSync(path.join(dir, 'background.js'), 'console.log(1)');
  writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'AEGIS',
      version: '1.0.0',
      description: 'd',
      icons: { 128: 'icons/128.png' },
      permissions: ['storage'],
      host_permissions: ['https://api.groq.com/*'],
      content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; connect-src 'self' https://api.groq.com" },
    }),
  );
  return dir;
}

describe('release gate (verify-release)', () => {
  it('accepts a complete release', () => {
    expect(verifyBuild(fakeRelease())).toEqual([]);
  });

  it('rejects a model that is missing, altered, or unexpected', () => {
    const missing = fakeRelease();
    rmSync(path.join(missing, 'models', 'm.onnx'));
    expect(verifyBuild(missing).join('\n')).toMatch(/model missing from the build: m\.onnx/);

    const altered = fakeRelease();
    writeFileSync(path.join(altered, 'models', 'm.onnx'), 'tampered!!!');
    expect(verifyBuild(altered).join('\n')).toMatch(/altered or truncated/);

    const extra = fakeRelease();
    writeFileSync(path.join(extra, 'models', 'big-extra-model.onnx'), 'x');
    expect(verifyBuild(extra).join('\n')).toMatch(/unexpected file in models\/: big-extra-model\.onnx/);
  });

  it('rejects wider host access or a looser connection policy than the model API', () => {
    const dir = fakeRelease();
    const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    manifest.host_permissions = ['<all_urls>'];
    manifest.content_security_policy.extension_pages = "script-src 'self'; connect-src *";
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    const problems = verifyBuild(dir).join('\n');
    expect(problems).toMatch(/host_permissions must be exactly/);
    expect(problems).toMatch(/connect-src/);
  });

  it('rejects development leftovers and anything shaped like an API key', () => {
    const dir = fakeRelease();
    writeFileSync(path.join(dir, 'background.js'), 'fetch("http://localhost:8787"); const k = "gsk_' + 'a'.repeat(30) + '";');
    const problems = verifyBuild(dir).join('\n');
    expect(problems).toMatch(/localhost:8787/);
    expect(problems).toMatch(/API key/);
  });

  it('rejects a build with no WebAssembly runtime, no icons, or source maps', () => {
    const dir = fakeRelease();
    rmSync(path.join(dir, 'assets', 'ort.wasm'));
    writeFileSync(path.join(dir, 'background.js.map'), '{}');
    const problems = verifyBuild(dir).join('\n');
    expect(problems).toMatch(/WebAssembly binary/);
    expect(problems).toMatch(/source map/);
  });
});

describe('model gate (verify-models)', () => {
  it('passes for the models actually bundled in this checkout', async () => {
    expect(await verifyModels()).toEqual([]);
  });

  it('names what is wrong and how to fix it', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aegis-models-'));
    dirs.push(dir);
    writeFileSync(
      path.join(dir, 'models.manifest.json'),
      JSON.stringify({ models: [{ id: 'fetched', file: 'a.onnx', sha256: 'x', bytes: 1, source: 'https://host/a.onnx' }, { id: 'generated', file: 'b.onnx', sha256: 'x', bytes: 1, source: 'generated locally: tools/models/x.py' }] }),
    );
    const problems = (await verifyModels(dir)).join('\n');
    expect(problems).toMatch(/fetched: a\.onnx is missing - run `pnpm exec tsx scripts\/fetch-models\.ts`/);
    expect(problems).toMatch(/generated: b\.onnx is missing - generate it/);
  });
});

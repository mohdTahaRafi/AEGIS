/**
 * Release gate, run on a finished production build (`.output/<target>`): what a user installs must
 * work end to end with nothing else to download, and must carry nothing meant for development.
 *
 *   tsx scripts/verify-release.ts chrome-mv3 [firefox-mv3 ...]
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_API_HOST_PERMISSION = 'https://api.groq.com/*';
const FORBIDDEN_PERMISSIONS = ['debugger', 'webRequest', 'history', 'cookies', 'clipboardRead', 'management', 'downloads', 'nativeMessaging'];
// Strings that only exist for development: the legacy gateway, its token, an unpinned CDN, a hub.
// A Groq key baked into a build would hand one user's quota to everyone who installs it.
const API_KEY_SHAPE = /gsk_[A-Za-z0-9]{20,}/;
const DEV_ONLY_MARKERS = ['localhost:8787', 'dev-token', 'cdn.jsdelivr.net', 'unpkg.com', 'huggingface.co', 'aegis_debug_ablation_arm'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

export function verifyBuild(outDir: string): string[] {
  const problems: string[] = [];
  const manifestPath = path.join(outDir, 'manifest.json');
  if (!existsSync(manifestPath)) return [`${outDir}: no manifest.json - was the production build run?`];
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;

  if (manifest.manifest_version !== 3) problems.push('manifest_version is not 3');
  const hostPermissions = (manifest.host_permissions as string[] | undefined) ?? [];
  if (hostPermissions.length !== 1 || hostPermissions[0] !== MODEL_API_HOST_PERMISSION) {
    problems.push(`host_permissions must be exactly [${MODEL_API_HOST_PERMISSION}], got ${JSON.stringify(hostPermissions)}`);
  }
  for (const perm of [...((manifest.permissions as string[] | undefined) ?? []), ...((manifest.optional_permissions as string[] | undefined) ?? [])]) {
    if (FORBIDDEN_PERMISSIONS.includes(perm)) problems.push(`forbidden permission: ${perm}`);
  }
  const csp = (manifest.content_security_policy as { extension_pages?: string } | undefined)?.extension_pages ?? '';
  const connect = /connect-src ([^;]*)/.exec(csp)?.[1]?.trim();
  if (connect !== `'self' https://api.groq.com`) problems.push(`extension_pages CSP must limit connect-src to the extension and the model API, got: ${connect ?? 'none'}`);

  const icons = Object.values((manifest.icons as Record<string, string> | undefined) ?? {});
  if (icons.length === 0) problems.push('manifest declares no icons');
  for (const icon of icons) if (!existsSync(path.join(outDir, icon))) problems.push(`icon file missing: ${icon}`);
  if (!manifest.name || !manifest.version || !manifest.description) problems.push('name, version and description are all required');

  // Models: exactly the pinned set, intact.
  const modelsDir = path.join(outDir, 'models');
  if (!existsSync(modelsDir)) {
    problems.push('no models/ directory in the build');
  } else {
    const pinned = JSON.parse(readFileSync(path.join(modelsDir, 'models.manifest.json'), 'utf8')) as { models: { id: string; file: string; sha256: string; bytes: number }[] };
    const expected = new Set(['models.manifest.json', ...pinned.models.map((m) => m.file)]);
    for (const model of pinned.models) {
      const file = path.join(modelsDir, model.file);
      if (!existsSync(file)) problems.push(`model missing from the build: ${model.file}`);
      else if (statSync(file).size !== model.bytes || createHash('sha256').update(readFileSync(file)).digest('hex') !== model.sha256) problems.push(`model altered or truncated in the build: ${model.file}`);
    }
    for (const entry of readdirSync(modelsDir)) if (!expected.has(entry)) problems.push(`unexpected file in models/: ${entry} (a release ships only the pinned models)`);
  }

  const files = walk(outDir);
  if (!files.some((f) => f.endsWith('.wasm'))) problems.push('the ONNX Runtime WebAssembly binary is not in the build (the models could not run offline)');
  for (const file of files) {
    if (file.endsWith('.map')) problems.push(`source map shipped: ${path.relative(outDir, file)}`);
    if (!/\.(js|mjs|html|json)$/.test(file) || file.startsWith(modelsDir)) continue;
    const text = readFileSync(file, 'utf8');
    if (API_KEY_SHAPE.test(text)) problems.push(`something shaped like an API key is in ${path.relative(outDir, file)}`);
    for (const marker of DEV_ONLY_MARKERS) if (text.includes(marker)) problems.push(`development-only string "${marker}" found in ${path.relative(outDir, file)}`);
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const targets = process.argv.slice(2);
  if (targets.length === 0) targets.push('chrome-mv3');
  let failed = false;
  for (const target of targets) {
    const outDir = path.join(root, '.output', target);
    const problems = verifyBuild(outDir);
    if (problems.length > 0) {
      failed = true;
      console.error(`[aegis] release check FAILED for ${target}`);
      for (const p of problems) console.error(`  - ${p}`);
    } else {
      const bytes = walk(outDir).reduce((sum, f) => sum + statSync(f).size, 0);
      console.log(`[aegis] release check passed for ${target} (${(bytes / 1e6).toFixed(1)} MB unpacked)`);
    }
  }
  if (failed) process.exit(1);
}

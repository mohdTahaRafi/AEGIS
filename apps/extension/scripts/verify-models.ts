/**
 * Release gate, run before every build/zip: every model listed in public/models/models.manifest.json
 * must be on disk with the exact pinned size and sha256. A release is the only thing a user installs
 * and nothing is downloaded afterwards (FR-13), so a missing or altered model must stop the build,
 * not surface as a load error on someone's machine.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const modelsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'models');

interface ManifestModel {
  id: string;
  file: string;
  sha256: string;
  bytes: number;
  source: string;
}

export async function verifyModels(dir = modelsDir): Promise<string[]> {
  const manifest = JSON.parse(await readFile(path.join(dir, 'models.manifest.json'), 'utf8')) as { models: ManifestModel[] };
  const problems: string[] = [];
  for (const model of manifest.models) {
    let bytes: Buffer;
    try {
      bytes = await readFile(path.join(dir, model.file));
    } catch {
      const how = /^https?:\/\//.test(model.source)
        ? 'run `pnpm exec tsx scripts/fetch-models.ts`'
        : 'generate it as described in its "source" field in models.manifest.json (tools/models/*.py)';
      problems.push(`${model.id}: ${model.file} is missing - ${how}`);
      continue;
    }
    if (bytes.byteLength !== model.bytes) problems.push(`${model.id}: ${model.file} is ${bytes.byteLength} bytes, expected ${model.bytes}`);
    else if (createHash('sha256').update(bytes).digest('hex') !== model.sha256) problems.push(`${model.id}: ${model.file} does not match its pinned sha256`);
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = await verifyModels();
  if (problems.length > 0) {
    console.error('[aegis] release blocked: bundled models are not intact');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('[aegis] every bundled model is present and matches its pinned sha256');
}

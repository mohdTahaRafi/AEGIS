/**
 * Downloads pinned models listed in public/models/models.manifest.json and verifies their
 * sha256 before writing them to disk (FR-13: no runtime model download; every model ships
 * verified inside the package). Run manually / in CI, never at extension runtime.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modelsDir = path.join(__dirname, '..', 'public', 'models');
const manifestPath = path.join(modelsDir, 'models.manifest.json');

// GitHub serves LFS-tracked files as pointer text from raw.githubusercontent.com; the actual
// bytes come from the media endpoint.
function toMediaUrl(githubBlobUrl: string): string {
  const m = githubBlobUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
  if (!m) throw new Error(`Unrecognised source URL shape: ${githubBlobUrl}`);
  const [, owner, repo, rest] = m;
  return `https://media.githubusercontent.com/media/${owner}/${repo}/${rest}`;
}

interface ManifestModel {
  id: string;
  file: string;
  sha256: string;
  bytes: number;
  source: string;
}

async function main() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { models: ManifestModel[] };
  await mkdir(modelsDir, { recursive: true });

  for (const model of manifest.models) {
    const dest = path.join(modelsDir, model.file);
    if (existsSync(dest)) {
      const existing = await readFile(dest);
      const hash = createHash('sha256').update(existing).digest('hex');
      if (hash === model.sha256) {
        console.log(`[aegis] ${model.id}: already present and verified (${model.bytes} bytes)`);
        continue;
      }
      console.warn(`[aegis] ${model.id}: on-disk hash mismatch, refetching`);
    }

    const url = toMediaUrl(model.source);
    console.log(`[aegis] ${model.id}: fetching ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Fetch failed for ${model.id}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());

    const hash = createHash('sha256').update(buf).digest('hex');
    if (hash !== model.sha256) {
      throw new Error(
        `[aegis] SHA-256 MISMATCH for ${model.id}: expected ${model.sha256}, got ${hash}. Refusing to write.`,
      );
    }
    if (buf.byteLength !== model.bytes) {
      throw new Error(
        `[aegis] SIZE MISMATCH for ${model.id}: expected ${model.bytes} bytes, got ${buf.byteLength}.`,
      );
    }

    await writeFile(dest, buf);
    console.log(`[aegis] ${model.id}: verified and written (${buf.byteLength} bytes, sha256 ok)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

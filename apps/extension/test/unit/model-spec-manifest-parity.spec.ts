// entrypoints/sidepanel/main.tsx hand-duplicates each public/models/models.manifest.json entry's
// sha256 into a *_MODEL_SPEC constant (public/ assets aren't part of the module graph, so this
// can't just be an import — see that file's own comment on FACE_MODEL_SPEC). Those comments
// promise a mismatch "fails loudly" — true, but only at runtime, for a real user, after a real
// model regeneration is forgotten to be mirrored here (exactly what happened to vit-prompts-b32
// after its 2026-09-27 regeneration: models.manifest.json was updated, VIT_VISION_MODEL_SPEC's
// assetSha256 was not, and the ViT/CLIP screen classifier silently failed to load in the live
// extension despite every unit test passing, since nothing checked the two files agreed). This
// test makes that drift fail at test time instead: every hash in the manifest must appear
// somewhere in main.tsx's source.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');

interface ManifestModel {
  id: string;
  sha256: string;
}

describe('models.manifest.json / main.tsx MODEL_SPEC parity', () => {
  const manifest = JSON.parse(
    readFileSync(path.join(ROOT, 'public/models/models.manifest.json'), 'utf8'),
  ) as { models: ManifestModel[] };
  const mainTsxSource = readFileSync(
    path.join(ROOT, 'entrypoints/sidepanel/main.tsx'),
    'utf8',
  );

  for (const model of manifest.models) {
    it(`${model.id}'s manifest sha256 is mirrored in main.tsx`, () => {
      expect(mainTsxSource).toContain(model.sha256);
    });
  }
});

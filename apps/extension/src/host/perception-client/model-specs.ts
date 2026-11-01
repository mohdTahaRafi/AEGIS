// The perception models the panel's worker loads, mirroring `public/models/models.manifest.json`.
// [A] Duplicated rather than imported: `public/` assets are runtime-fetched static files in
// WXT/Vite's model, not part of the module graph. A mismatch fails loudly (sha256 verification in
// `perception/runtime/sessions.ts` rejects a stale hash), and
// `test/unit/model-spec-manifest-parity.spec.ts` compares the two.

// Mirrors public/models/models.manifest.json's face entry (T-4.3). [A] Duplicated rather than
// imported: `public/` assets are runtime-fetched static files in WXT/Vite's model, not part of
// the module graph — importing JSON from there would require a build-time file read this
// entrypoint has no reason to also own. Kept in sync by hand; a mismatch fails loudly (sha256
// verification in `runtime/sessions.ts` rejects a stale hash) rather than silently.
export const FACE_MODEL_SPEC = {
  id: 'face-yunet-2023mar',
  role: 'face' as const,
  url: '/models/face_detection_yunet_2023mar.onnx',
  sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
  resident: true,
};

// Mirrors models.manifest.json's three OCR entries (T-6.3/T-6.4) — same hand-duplication pattern
// and the same reason (public/ assets aren't part of the module graph). `resident: false`: OCR
// lazy-loads on first use (the halo re-scan today; a future T-6.5/T-6.6 fusion integration would
// be its other caller), per design.md §6.4's degradation ladder.
export const OCR_DET_MODEL_SPEC = {
  id: 'ocr-det-ppocrv5-mobile',
  role: 'ocr-det' as const,
  url: '/models/ocr_det_ppocrv5_mobile.onnx',
  sha256: '4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae',
  resident: false,
};
export const OCR_REC_EN_MODEL_SPEC = {
  id: 'ocr-rec-ppocrv5-mobile-en',
  role: 'ocr-rec' as const,
  script: 'latin' as const,
  url: '/models/ocr_rec_ppocrv5_mobile_en.onnx',
  sha256: 'c3461add59bb4323ecba96a492ab75e06dda42467c9e3d0c18db5d1d21924be8',
  dictUrl: '/models/ocr_rec_ppocrv5_mobile_en.dict.txt',
  dictSha256: 'e025a66d31f327ba0c232e03f407ae8d105e1e709e7ccb3f408aa778c24e70d6',
  resident: false,
};
export const OCR_REC_DEVANAGARI_MODEL_SPEC = {
  id: 'ocr-rec-ppocrv5-mobile-devanagari',
  role: 'ocr-rec' as const,
  script: 'devanagari' as const,
  url: '/models/ocr_rec_ppocrv5_mobile_devanagari.onnx',
  sha256: 'd6f0a906580e3fa6b324a318718f1f31f268b6ea8ef985f91c2012a37f52c91e',
  dictUrl: '/models/ocr_rec_ppocrv5_mobile_devanagari.dict.txt',
  dictSha256: '09c7440bfc5477e5c41052304b6b185aff8c4a5e8b2b4c23c1c706f6fe1ee9fc',
  resident: false,
};

// Mirrors models.manifest.json's `vit-vision-clip-b32`/`vit-prompts-b32` entries (T-4.5/T-4.6),
// same hand-duplication pattern. `resident: true`: design.md §19 keeps the ViT encoder resident
// alongside the face detector, unlike OCR.
export const VIT_VISION_MODEL_SPEC = {
  id: 'vit-vision-clip-b32',
  role: 'vit' as const,
  url: '/models/vit-vision.onnx',
  sha256: '2d070b5e6edc1ab9c849333753154025e780491b870bf4d0360f40b8378f19d6',
  assetUrl: '/models/vit-prompts.bin',
  assetSha256: '4bc4eecc655897ad2b48f2b79a965cd6fc888b8608b7f7ba422af70403d105e1',
  resident: true,
};


export const PERCEPTION_MODELS = [FACE_MODEL_SPEC, OCR_DET_MODEL_SPEC, OCR_REC_EN_MODEL_SPEC, OCR_REC_DEVANAGARI_MODEL_SPEC, VIT_VISION_MODEL_SPEC];

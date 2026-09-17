import { defineConfig } from 'wxt';

// Chrome opts into cross-origin isolation so WASM can use threads (architecture §5.1).
// Firefox grants SharedArrayBuffer only to privileged extensions, so its build stays single-threaded.
const crossOriginIsolation = {
  cross_origin_embedder_policy: { value: 'require-corp' },
  cross_origin_opener_policy: { value: 'same-origin' },
};

export default defineConfig({
  srcDir: '.',
  outDir: '.output',
  manifest: ({ browser, manifestVersion }) => ({
    name: 'AEGIS',
    description: 'Privacy-preserving browser agent with on-device visual perception',
    permissions: ['scripting', 'tabs', 'storage', ...(browser === 'chrome' ? ['sidePanel'] : [])],
    optional_host_permissions: ['<all_urls>'],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'",
    },
    ...(browser === 'chrome' ? crossOriginIsolation : {}),
    ...(browser === 'firefox'
      ? { browser_specific_settings: { gecko: { id: 'aegis@sih26171.local' } } }
      : {}),
    ...(manifestVersion === 3 ? {} : {}),
  }),
  vite: () => ({
    // ONNX Runtime Web ships its own WASM binaries; they are copied into public/ort by
    // scripts/fetch-models.ts and referenced by extension URL, never fetched from a CDN.
    optimizeDeps: { exclude: ['onnxruntime-web'] },
  }),
});

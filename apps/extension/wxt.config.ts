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
  // Manifest V3 on both browsers (architecture.md §10.3). WXT's `sidepanel` entrypoint maps
  // itself to Chrome `side_panel` / Firefox `sidebar_action`; no manual wiring needed.
  manifestVersion: 3,
  manifest: ({ browser }) => ({
    name: 'AEGIS',
    description: 'Privacy-preserving browser agent with on-device visual perception',
    permissions: ['scripting', 'tabs', 'storage'],
    optional_host_permissions: ['<all_urls>'],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'",
    },
    ...(browser === 'chrome' ? crossOriginIsolation : {}),
    ...(browser === 'firefox'
      ? { browser_specific_settings: { gecko: { id: 'aegis@sih26171.local' } } }
      : {}),
  }),
  // Pre-submission / unpacked-only builds during SIH; store data-collection disclosure is
  // out of scope unless the team decides to publish (README.md "Store publication").
  suppressWarnings: { firefoxDataCollection: true },
  vite: () => ({
    optimizeDeps: { exclude: ['onnxruntime-web'] },
  }),
});

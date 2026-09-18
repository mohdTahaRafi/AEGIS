import path from 'node:path';
import { defineConfig } from 'wxt';

// `wxt.config.ts` is loaded as ESM (this file uses `import`) — CommonJS's `__dirname` global
// does not exist here. `srcDir: '.'` below is WXT's own proof that this file's paths are meant
// to be CWD-relative (WXT always invokes with cwd set to the project root), so that's what the
// alias below resolves against too.
const ROOT_DIR = process.cwd();

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
  vite: (env) => ({
    optimizeDeps: { exclude: ['onnxruntime-web'] },
    // design.md §18.3, T-6.9: `entrypoints/sidepanel/main.tsx` dynamically imports
    // `src/debug/ablations.ts` behind an `import.meta.env.DEV` check — but a dynamic `import()`
    // of a literal specifier still gets its own chunk in the OUTPUT regardless of that check
    // (dead-code elimination happens after Rollup/Rolldown has already decided to split the
    // chunk, so it can't retroactively un-create the file — found by writing the real
    // build-output test T-6.9's AC asks for, not assumed). Swapping the real module for an inert
    // stub on an actual production build keeps the switch's storage key out of every artifact
    // under `.output/`, not just unreachable from a running release build. Scoped as narrowly as
    // possible (`command === 'build' && mode === 'production'` only) so it can never accidentally
    // shadow the real module for the dev server or any test run.
    //
    // `find` is a fully-anchored (`^...$`) regex, not a bare suffix pattern — Rollup/Rolldown's
    // alias plugin does a plain `specifier.replace(find, replacement)`, so a suffix-only pattern
    // (e.g. `/\/debug\/ablations$/`) only replaces the MATCHED tail and leaves the `../../src`
    // prefix concatenated onto the (already absolute) replacement path — a real, reproduced bug,
    // not a hypothetical: it silently built a broken `../../src/home/…` specifier and failed
    // with "was not an absolute path" the first time this was written with an unanchored regex.
    resolve:
      env.command === 'build' && env.mode === 'production'
        ? { alias: [{ find: /^.*\/debug\/ablations$/, replacement: path.resolve(ROOT_DIR, 'src/debug/ablations.release-stub.ts') }] }
        : undefined,
  }),
});

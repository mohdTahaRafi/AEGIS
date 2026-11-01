import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'wxt';
import { MODEL_API_ORIGINS } from './src/host/egress/providers';

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

// The only files of `public/models/` a release ships: exactly what `models.manifest.json` lists. A
// developer's checkout may also hold the ~950 MB optional NER model and its runtime copies there
// (gitignored, used by browser tests); a release must never pick those up by accident.
function shippedModelFiles(): Set<string> {
  const manifest = JSON.parse(readFileSync(path.join(ROOT_DIR, 'public/models/models.manifest.json'), 'utf8')) as { models: { file: string }[] };
  return new Set(['models.manifest.json', ...manifest.models.map((m) => m.file)]);
}

// Where a release's extension pages may connect: the extension itself and the model APIs a user's
// own key can be for (src/host/egress/providers.ts). Nothing else — a page script or a bug cannot
// send data anywhere else.
const MODEL_API_CONNECT = MODEL_API_ORIGINS.join(' ');

export default defineConfig({
  srcDir: '.',
  outDir: '.output',
  // Manifest V3 on both browsers (architecture.md §10.3). WXT's `sidepanel` entrypoint maps
  // itself to Chrome `side_panel` / Firefox `sidebar_action`; no manual wiring needed.
  manifestVersion: 3,
  manifest: ({ browser, mode }) => ({
    name: 'AEGIS',
    description: 'Privacy-preserving browser agent with on-device visual perception',
    // Site access is REQUIRED (`<all_urls>` in host_permissions), in every build. Measured
    // 2026-10-10 in Chromium 153 on the release build: `tabs.captureVisibleTab` succeeds with a
    // required `<all_urls>`, and fails ("Either the '<all_urls>' or 'activeTab' permission is
    // required") with the same pattern as an optional permission even after the user switches it
    // to "On all sites" — so with optional access, every new site a task moved to needed a click
    // on the toolbar icon, and an autonomous multi-site task was impossible. The agent still sends
    // nothing that is not redacted and guarded; site access only lets it read and screenshot the
    // task's own tab. A user who restricts it in Chrome ("On click") gets the activeTab path:
    // `activeTab` + the toolbar click (`action.onClicked`, entrypoints/background.ts).
    permissions: ['scripting', 'tabs', 'storage', 'activeTab'],
    // Declared explicitly: without an `action` key Chrome still draws an implicit toolbar icon, but
    // `browser.action` (and so `action.onClicked`, the one path that grants `activeTab`) does not
    // exist.
    action: { default_title: 'AEGIS' },
    // A release's other hosts are the model APIs a user's own key can be for.
    host_permissions: mode !== 'production' ? ['<all_urls>'] : ['<all_urls>', ...MODEL_API_ORIGINS.map((o) => `${o}/*`)],
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; " +
        // Development builds may also talk to a local model stand-in or the legacy gateway.
        (mode === 'production' ? `connect-src 'self' ${MODEL_API_CONNECT}` : `connect-src 'self' ${MODEL_API_CONNECT} http://localhost:* http://127.0.0.1:*`),
    },
    // Side panel (114), `AbortSignal.any` (116).
    ...(browser === 'chrome' ? { minimum_chrome_version: '116' } : {}),
    ...(browser === 'chrome' ? crossOriginIsolation : {}),
    ...(browser === 'firefox'
      ? { browser_specific_settings: { gecko: { id: 'aegis@sih26171.local', strict_min_version: '128.0' } } }
      : {}),
  }),
  zip: { name: 'aegis' },
  hooks: {
    'build:publicAssets': (wxt, files) => {
      if (wxt.config.mode !== 'production') return;
      const shipped = shippedModelFiles();
      for (let i = files.length - 1; i >= 0; i--) {
        const dest = files[i]!.relativeDest.replaceAll('\\', '/');
        if (dest.startsWith('models/') && !shipped.has(dest.slice('models/'.length))) files.splice(i, 1);
      }
    },
  },
  // Pre-submission / unpacked-only builds during SIH; store data-collection disclosure is
  // out of scope unless the team decides to publish (README.md "Store publication").
  suppressWarnings: { firefoxDataCollection: true },
  vite: (env) => ({
    // Shown as the panel's first Setup line, so a run can be tied to the build that produced it.
    define: { 'import.meta.env.VITE_AEGIS_BUILD': JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')) },
    optimizeDeps: { exclude: ['onnxruntime-web', '@huggingface/transformers'] },
    // T-6.8, 2026-09-26: real root cause, found by reading the actual built output, not guessed —
    // Vite's default `worker.format` is `'iife'`. An IIFE bundle has no native module resolution,
    // so Rollup/Vite's own dynamic-`import()` polyfill for IIFE workers ALWAYS routes through a
    // fetch-as-text-then-`Blob`-then-`import(URL.createObjectURL(...))` shim — confirmed directly:
    // the built `assets/worker-*.js` literally starts with `(function(){...})()`. That shim is what
    // was producing "Failed to fetch dynamically imported module: blob:chrome-extension://..." for
    // `@huggingface/transformers`'s own internal `await import(...)` calls (its ONNX Runtime Web
    // backend dynamically imports its WASM/JSEP glue module) — this extension's CSP is `script-src
    // 'self' 'wasm-unsafe-eval'` (below), which has no reason to ever allow a `blob:` script source,
    // and correctly blocks it. The perception worker is already constructed with `{ type: 'module'
    // }` (`entrypoints/sidepanel/main.tsx`'s `createPerceptionClient`), so real ES-module output is
    // exactly what the runtime expects — Vite defaults to IIFE purely for broad legacy-browser
    // compatibility, which this MV3-only, Chromium/Firefox-only extension never needs. `format:
    // 'es'` makes dynamic imports native `import()` calls again, with no blob involved at all.
    worker: { format: 'es' },
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

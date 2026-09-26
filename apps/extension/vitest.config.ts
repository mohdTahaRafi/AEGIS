import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

// WxtVitest() provides the `browser`/`defineContentScript`/etc. auto-imports plus `fakeBrowser`
// (an in-memory WebExtension API implementation, from wxt/testing/fake-browser) so port/background
// code that calls `browser.*` can be unit-tested without a real extension loaded (T-2.5, T-2.6).
// Scoped to the 'node' project only — its setup file fails to load under real-browser (Playwright)
// execution, and the browser-mode tests never touch `browser.*` anyway.
// Top-level await (config files are ESM) sidesteps `defineConfig`'s async-factory overload, which
// does not resolve cleanly against a `test.projects` return shape.
const wxtVitestPlugins = await WxtVitest();

export default defineConfig({
  test: {
    // Most Phase 0 code is browser/worker-only; real unit coverage starts in Phase 2/3.
    // Failing a clean checkout because no *.test.ts exists yet would be a false CI failure.
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        plugins: wxtVitestPlugins,
        test: {
          name: 'node',
          include: ['test/unit/**/*.{test,spec}.{ts,tsx}'],
          exclude: ['test/browser/**'],
          // manifest.spec.ts and ablation-build.spec.ts both invoke real `wxt build` calls against
          // the same shared `.output/{chrome,firefox}-mv3` directories (T-6.9's own "build for
          // real, inspect .output/" discipline — see ablation-build.spec.ts's doc comment). WXT
          // wipes and recreates that directory on every build, so running these files in separate
          // parallel workers races: one file's build-start wipe can delete the other's
          // just-written output mid-read, producing a transient ENOENT. Real, reproduced
          // (2026-09-26) — not a flaky test, a genuine cross-process shared-mutable-directory
          // race, made more likely once `public/models/` grew to ~1GB (T-4.5/T-6.8) and each
          // build's copy step takes measurably longer. Serializing this project's files removes
          // the race entirely; the browser project (no build-invoking tests) is unaffected.
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          // Real Chromium via Playwright, not jsdom: getBoundingClientRect, elementsFromPoint,
          // checkVisibility and Range.getClientRects all need real layout (phase_2_spine.md §3.3,
          // same reasoning as Phase 1's Playwright-driven fixture harness in eval/).
          name: 'browser',
          include: ['test/browser/**/*.spec.ts', 'test/e2e/**/*.spec.ts'],
          browser: {
            enabled: true,
            // T-6.8, 2026-09-26: Playwright's own `headless: true` shortcut launches Chromium's
            // stripped "headless shell" binary — real, reproduced: it never exposes `navigator.gpu`
            // at all (`'gpu' in navigator` is `false`), on any page, regardless of GPU flags, real
            // driver health, or device permissions (all independently confirmed fine on this
            // machine via a real NVIDIA/Vulkan/ANGLE renderer, verified through a raw CDP
            // `SystemInfo.getInfo` call). Real Chromium (headless via the `--headless=new` runtime
            // flag, not the separate headless-shell binary) does expose it — the exact same
            // distinction `eval/src/aegis_eval/runner/browser.py`'s own doc comment already found
            // for extension-loading; this is a second, independent real-world case of the same
            // Playwright quirk. `headless: false` here selects the full binary; the flag below is
            // what actually keeps it headless.
            provider: playwright({ launchOptions: { headless: false, args: ['--headless=new', '--use-gl=angle', '--use-angle=vulkan', '--enable-unsafe-webgpu'] } }),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});

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
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});

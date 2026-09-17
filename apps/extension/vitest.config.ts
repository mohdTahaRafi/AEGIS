import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Most Phase 0 code is browser/worker-only; real unit coverage starts in Phase 2/3.
    // Failing a clean checkout because no *.test.ts exists yet would be a false CI failure.
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          include: ['test/unit/**/*.{test,spec}.ts'],
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
          include: ['test/browser/**/*.spec.ts'],
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

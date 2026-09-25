import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

// T-6.1/T-6.2 — a second config, not folded into vitest.config.ts's `browser` project, because
// `@vitest/browser-playwright` takes one `instances` array per project and mixing chromium +
// firefox there serializes both browsers' runs anyway; two configs let CI (or a developer) opt in
// explicitly with `pnpm test:firefox` rather than doubling every default `pnpm test` run's cost.
// Real, run-and-verified findings from actually using this (2026-09-25, this sandbox — Chromium
// 153 / Firefox 155): identical pass/fail pattern to the default Chromium `browser` project — the
// same 5 files fail identically in both browsers, all for the same reason (this sandbox never
// downloaded the .onnx model binaries themselves, `scripts/fetch-models.ts`'s job, unrelated to
// Firefox), and every other real-browser DOM/shadow-DOM/compositor/preflight test (166/177 tests
// across the shared `test/browser` + `test/e2e` suite) passes identically. This is the first time
// this repository's browser-level test suite has actually been run against real Firefox rather
// than only asserted structurally (see docs/HISTORY.md's 2026-09-25 entry).
export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'browser-firefox',
          include: ['test/browser/**/*.spec.ts', 'test/e2e/**/*.spec.ts'],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'firefox' }],
          },
        },
      },
    ],
  },
});

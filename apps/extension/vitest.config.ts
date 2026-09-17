import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Most Phase 0 code is browser/worker-only; real unit coverage starts in Phase 2/3.
    // Failing a clean checkout because no *.test.ts exists yet would be a false CI failure.
    passWithNoTests: true,
  },
});

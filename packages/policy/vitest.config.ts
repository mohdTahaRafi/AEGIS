import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Empty scaffold until Phase 3 (T-3.6, T-3.7). See apps/extension/vitest.config.ts for
    // why this doesn't fail a clean checkout.
    passWithNoTests: true,
  },
});

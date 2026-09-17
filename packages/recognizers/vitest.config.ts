import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Empty scaffold until Phase 3 (T-3.1...T-3.5). See apps/extension/vitest.config.ts for
    // why this doesn't fail a clean checkout.
    passWithNoTests: true,
  },
});

// @ts-check
import tseslint from 'typescript-eslint';

/**
 * Dependency rules from architecture.md §15.3, enforced mechanically rather than by review.
 * The Python-side rule (server/* never imports eval/*, eval/* never imported by product code)
 * is not expressed here — there is no shared JS/TS boundary to lint for it, and neither
 * server/gateway nor eval/ has Python code yet that could violate it (Phase 2+).
 *
 * Two §15.3 rules are deliberately NOT here:
 *  - `packages/protocol → no runtime deps beyond the validator` is a package.json dependency
 *    constraint, not an import-boundary one; nothing currently violates it.
 *  - `src/host/privacy/vault → exports no serialize/toJSON` doesn't exist as a folder yet
 *    (Phase 3). Adding the rule now would pass trivially; it is written when the folder is.
 */

const BOUNDARY_MESSAGE =
  'apps/extension/src/{content,host,perception} are three JavaScript execution contexts that ' +
  'cannot share memory (architecture.md §5.3) — they talk only by message, never by import.';

/** @type {import('eslint').Linter.RulesRecord} */
const noBrowserGlobalsRules = {
  'no-restricted-globals': [
    'error',
    { name: 'document', message: 'packages/recognizers and packages/policy are pure logic, reused by the Python-adjacent evaluation harness in Node — no browser APIs (architecture.md §15.3).' },
    { name: 'window', message: 'No browser APIs in packages/recognizers or packages/policy (architecture.md §15.3).' },
    { name: 'navigator', message: 'No browser APIs in packages/recognizers or packages/policy (architecture.md §15.3).' },
    { name: 'location', message: 'No browser APIs in packages/recognizers or packages/policy (architecture.md §15.3).' },
    { name: 'localStorage', message: 'No browser APIs in packages/recognizers or packages/policy (architecture.md §15.3).' },
    { name: 'sessionStorage', message: 'No browser APIs in packages/recognizers or packages/policy (architecture.md §15.3).' },
    { name: 'fetch', message: 'No browser APIs in packages/recognizers or packages/policy (architecture.md §15.3).' },
    { name: 'chrome', message: 'No WebExtension APIs in packages/recognizers or packages/policy (architecture.md §15.3).' },
    { name: 'browser', message: 'No WebExtension APIs in packages/recognizers or packages/policy (architecture.md §15.3).' },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.venv/**',
      '**/.output/**',
      '**/.wxt/**',
      '**/dist/**',
      '**/.pytest_cache/**',
      '**/corpus/**',
      '**/build/**',
      '**/*.d.ts',
      '**/generated/**',
      'apps/extension/.wxt/**',
    ],
  },

  tseslint.configs.recommended,

  // packages/recognizers, packages/policy: no browser/WebExtension globals, no imports from
  // apps/, server/ or eval/. Pure logic, reused by the harness in plain Node.
  {
    files: ['packages/recognizers/**/*.{ts,tsx}', 'packages/policy/**/*.{ts,tsx}'],
    rules: {
      ...noBrowserGlobalsRules,
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/apps/**', '@aegis/extension', '@aegis/extension/**'], message: 'packages/recognizers and packages/policy must not import from apps/ (architecture.md §15.3).' },
            { group: ['**/server/**'], message: 'packages/recognizers and packages/policy must not import from server/ (architecture.md §15.3).' },
            { group: ['**/eval/**'], message: 'packages/recognizers and packages/policy must not import from eval/ (architecture.md §15.3).' },
          ],
        },
      ],
    },
  },

  // src/content: page frames, isolated world. May import packages/*, src/shared. Not host/
  // or perception/.
  {
    files: ['apps/extension/src/content/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/host/**', '**/host', '../host*', '../../host*', '../../../host*'], message: `src/content must not import src/host. ${BOUNDARY_MESSAGE}` },
            { group: ['**/perception/**', '**/perception', '../perception*', '../../perception*', '../../../perception*'], message: `src/content must not import src/perception. ${BOUNDARY_MESSAGE}` },
          ],
        },
      ],
    },
  },

  // src/perception: the dedicated Web Worker. May import packages/*, src/shared. Not host/
  // or content/.
  {
    files: ['apps/extension/src/perception/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/host/**', '**/host', '../host*', '../../host*', '../../../host*'], message: `src/perception must not import src/host. ${BOUNDARY_MESSAGE}` },
            { group: ['**/content/**', '**/content', '../content*', '../../content*', '../../../content*'], message: `src/perception must not import src/content. ${BOUNDARY_MESSAGE}` },
          ],
        },
      ],
    },
  },

  // src/host: the side panel / sidebar page. May import packages/*, src/shared. Talks to the
  // other two contexts by message only, so it does not import them either.
  {
    files: ['apps/extension/src/host/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/content/**', '**/content', '../content*', '../../content*', '../../../content*'], message: `src/host must not import src/content. ${BOUNDARY_MESSAGE}` },
            { group: ['**/perception/**', '**/perception', '../perception*', '../../perception*', '../../../perception*'], message: `src/host must not import src/perception directly — pass jobs through the typed worker message interface. ${BOUNDARY_MESSAGE}` },
          ],
        },
      ],
    },
  },

  // T-3.19 (FR-28) — the vault module (design.md §8) is importable only by src/host/privacy/**
  // (which builds/resolves it) and src/host/actions/** (rehydrate.ts calls `resolveFor`).
  // `session.ts` is a deliberate, disclosed exception: it owns the vault's lifecycle (construct
  // per task, `clear()` on cancel/stop/done — design.md §8's lifetime rule) and only ever calls
  // `describe()` (metadata only, never the value) or passes the instance down to builder/guard/
  // rehydrate — it never reads a resolved value itself. Every other host module is a stranger to
  // the vault by construction.
  {
    files: ['apps/extension/src/host/**/*.{ts,tsx}'],
    ignores: ['apps/extension/src/host/privacy/**', 'apps/extension/src/host/actions/**', 'apps/extension/src/host/session.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/privacy/vault', '**/privacy/vault/**', '../privacy/vault*', '../../privacy/vault*'],
              message: 'Only src/host/privacy/**, src/host/actions/** and session.ts (a disclosed exception — see eslint.config.js) may import the vault (T-3.19, design.md §8, FR-28).',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);

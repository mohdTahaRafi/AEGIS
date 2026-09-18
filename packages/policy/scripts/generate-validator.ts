/**
 * Precompiles `policy.schema.json` into a standalone (no-`eval`) Ajv validator, the same
 * technique `packages/protocol/scripts/generate.ts` already uses and for the exact same reason:
 * a real, previously-undiscovered bug found via genuine end-to-end testing (Phase 5) — the
 * extension's own manifest CSP (`script-src 'self' 'wasm-unsafe-eval'`, no `'unsafe-eval'`) makes
 * Ajv's default `ajv.compile()` throw at runtime inside the real built extension (it JIT-compiles
 * validators via `new Function`, which the CSP blocks). `packages/policy`'s `loader.ts` called
 * `ajv.compile()` live at module load — meaning `defaultPolicy` (imported at module scope by
 * `session.ts`) threw before the panel could even render. Unit tests never caught this because
 * jsdom/Node enforce no CSP at all.
 *
 * Run with: `npx tsx scripts/generate-validator.ts` (from `packages/policy/`).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import standaloneCode from 'ajv/dist/standalone/index.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(root, '..', 'policy.schema.json');
const generatedDir = path.join(root, '..', 'src', 'generated');

// Mirrors the runtime-require hoisting `packages/protocol/scripts/generate.ts` needs for the
// exact same reason (Ajv's standalone codegen emits `require("ajv/dist/runtime/...")` even under
// `esm: true`, and Node's ESM loader has no `require`).
function esmifyRuntimeRequires(code: string): string {
  const pattern = /const (\w+) = require\("(ajv\/dist\/runtime\/[\w-]+)"\)(\.default)?;/g;
  const imports: string[] = [];
  const consts: string[] = [];
  let n = 0;
  const withoutRequires = code.replace(pattern, (_match, varName, modPath) => {
    const ns = `__runtime_ns_${n++}`;
    imports.push(`import * as ${ns} from "${modPath}.js";`);
    consts.push(`const ${varName} = typeof ${ns}.default === 'function' ? ${ns}.default : ${ns}.default.default;`);
    return '';
  });
  if (imports.length === 0) return code;
  return imports.join('\n') + '\n' + consts.join('\n') + '\n' + withoutRequires;
}

function main(): void {
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const ajv = new Ajv2020({
    code: { source: true, esm: true },
    allErrors: true,
    strict: true,
  });
  ajv.addSchema(schema);

  const moduleCode = esmifyRuntimeRequires(standaloneCode(ajv, { validatePolicy: schema.$id }));

  mkdirSync(generatedDir, { recursive: true });
  const banner =
    '// GENERATED FILE — do not hand-edit. Run `npx tsx scripts/generate-validator.ts` to regenerate.\n' +
    '// Standalone Ajv validator (no Ajv compiler shipped in the bundle — see this script\'s header comment).\n';
  writeFileSync(path.join(generatedDir, 'validator.js'), banner + moduleCode);

  const dts =
    banner +
    'export interface AjvErrorObject {\n' +
    '  keyword: string;\n' +
    '  instancePath: string;\n' +
    '  message?: string;\n' +
    '  params: Record<string, unknown>;\n' +
    '}\n' +
    'export type AjvValidateFunction = ((data: unknown) => boolean) & {\n' +
    '  errors?: AjvErrorObject[] | null;\n' +
    '};\n' +
    'export declare const validatePolicy: AjvValidateFunction;\n';
  writeFileSync(path.join(generatedDir, 'validator.d.ts'), dts);

  console.log('[policy] standalone validator generated');
}

main();

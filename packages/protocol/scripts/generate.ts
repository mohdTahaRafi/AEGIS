/**
 * Schema → committed TypeScript types + standalone Ajv validators, and triggers Pydantic
 * generation for the gateway. One JSON Schema source (schema/*.schema.json), two committed
 * outputs. CI regenerates and diffs (T-1.10) to catch drift.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import standaloneCode from 'ajv/dist/standalone/index.js';
import { compile } from 'json-schema-to-typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const schemaDir = path.join(root, 'schema');
const generatedDir = path.join(root, 'src', 'generated');
const gatewayProtocolDir = path.join(
  root, '..', '..', 'server', 'gateway', 'src', 'aegis_gateway', 'protocol',
);

// Schema name -> exported TS type name / Ajv validator export name.
// Only the four "top level" contracts get TS types + validators; common.schema.json is
// definitions-only and pulled in by $ref.
const NAMED_SCHEMAS = [
  { file: 'sanitized-context.schema.json', typeName: 'SanitizedContext', validatorName: 'validateSanitizedContext' },
  { file: 'action-plan.schema.json', typeName: 'ActionPlan', validatorName: 'validateActionPlan' },
  { file: 'error.schema.json', typeName: 'ErrorResponse', validatorName: 'validateErrorResponse' },
] as const;

// session.schema.json holds two named definitions rather than one top-level shape.
const SESSION_DEFS = [
  { def: 'sessionCreate', typeName: 'SessionCreate', validatorName: 'validateSessionCreate' },
  { def: 'sessionCreated', typeName: 'SessionCreated', validatorName: 'validateSessionCreated' },
] as const;

async function generateTypeScriptTypes() {
  mkdirSync(generatedDir, { recursive: true });
  const banner =
    '// GENERATED FILE — do not hand-edit. Run `pnpm gen:protocol` to regenerate.\n' +
    '// Source: packages/protocol/schema/\n\n';

  // `name` is passed explicitly to compile() so the exported identifier is predictable
  // (SanitizedContext, not a title-derived SanitizedContextStepRequest) — but
  // json-schema-to-typescript prefers schema.title over the `name` param when both are
  // present, so `title` is stripped from the object handed to it (the schema file on disk,
  // and its title, are untouched). `cwd` is what lets relative $refs to common.schema.json
  // resolve.
  for (const { file, typeName } of NAMED_SCHEMAS) {
    const schema = JSON.parse(readFileSync(path.join(schemaDir, file), 'utf8'));
    delete schema.title;
    delete schema.$id;
    const ts = await compile(schema, typeName, {
      cwd: schemaDir,
      bannerComment: '',
      style: { singleQuote: true },
    });
    writeFileSync(path.join(generatedDir, `${kebab(typeName)}.ts`), banner + ts);
  }

  // session.schema.json has no top-level type; each named $def is compiled separately.
  const sessionSchema = JSON.parse(readFileSync(path.join(schemaDir, 'session.schema.json'), 'utf8'));
  for (const { def, typeName } of SESSION_DEFS) {
    const wrapper = { ...sessionSchema.$defs[def] };
    const ts = await compile(wrapper, typeName, { cwd: schemaDir, bannerComment: '' });
    writeFileSync(path.join(generatedDir, `${kebab(typeName)}.ts`), banner + ts);
  }

  const indexLines = [
    ...NAMED_SCHEMAS.map((s) => `export type { ${s.typeName} } from './${kebab(s.typeName)}.js';`),
    ...SESSION_DEFS.map((s) => `export type { ${s.typeName} } from './${kebab(s.typeName)}.js';`),
  ];
  writeFileSync(path.join(generatedDir, 'index.ts'), banner + indexLines.join('\n') + '\n');
}

function kebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function generateValidators() {
  const ajv = new Ajv2020({
    code: { source: true, esm: true },
    allErrors: true,
    strict: true,
    // The `type` action's oneOf([required:[ref]], required:[text]]) pattern (design.md §4.6)
    // references sibling properties from within a oneOf branch, which is valid JSON Schema but
    // trips Ajv's strictRequired heuristic. Everything else stays strict.
    strictRequired: false,
  });
  // Deliberately no ajv-formats: the one format that would have needed it (session_id) is
  // expressed as a `pattern` instead (see common.schema.json), because ajv-formats' format
  // functions pull in a `require()` call that standalone ESM output cannot resolve at runtime.

  const common = JSON.parse(readFileSync(path.join(schemaDir, 'common.schema.json'), 'utf8'));
  ajv.addSchema(common);

  // standaloneCode's multi-export form takes {exportName: schemaId}, not validate functions —
  // so schemas are registered with addSchema() and referenced by their $id string.
  const validatorIds: Record<string, string> = {};
  for (const { file, validatorName } of NAMED_SCHEMAS) {
    const schema = JSON.parse(readFileSync(path.join(schemaDir, file), 'utf8'));
    ajv.addSchema(schema);
    validatorIds[validatorName] = schema.$id;
  }
  const sessionSchema = JSON.parse(readFileSync(path.join(schemaDir, 'session.schema.json'), 'utf8'));
  for (const { def, validatorName } of SESSION_DEFS) {
    const wrapper = {
      $id: `https://aegis.local/schema/session-${def}.schema.json`,
      ...sessionSchema.$defs[def],
    };
    ajv.addSchema(wrapper);
    validatorIds[validatorName] = wrapper.$id;
  }

  const moduleCode = esmifyRuntimeRequires(standaloneCode(ajv, validatorIds));
  mkdirSync(generatedDir, { recursive: true });
  const banner =
    '// GENERATED FILE — do not hand-edit. Run `pnpm gen:protocol` to regenerate.\n' +
    '// Standalone Ajv validators (no Ajv compiler shipped in the bundle).\n';
  writeFileSync(path.join(generatedDir, 'validators.js'), banner + moduleCode);

  const dtsLines = Object.keys(validatorIds).map(
    (name) =>
      `export declare const ${name}: ((data: unknown) => boolean) & ` +
      `{ errors?: Array<{ instancePath: string; message?: string }> | null };`,
  );
  writeFileSync(
    path.join(generatedDir, 'validators.d.ts'),
    banner + dtsLines.join('\n') + '\n',
  );
}

/**
 * Ajv's standalone codegen emits `const fN = require("ajv/dist/runtime/X").default;` for a
 * few internal runtime helpers (e.g. ucs2length, used for Unicode-correct maxLength/minLength)
 * even when `code.esm: true` — `esm` only affects the export syntax, not these internal
 * requires. Node's ESM loader has no `require`, so the generated module fails to load as-is.
 * This hoists each such require into a real static `import` at the top of the file, which is
 * safe because they are module-scope const declarations, never inside a function body.
 */
function esmifyRuntimeRequires(code: string): string {
  const pattern = /const (\w+) = require\("(ajv\/dist\/runtime\/[\w-]+)"\)(\.default)?;/g;
  const imports: string[] = [];
  const consts: string[] = [];
  let n = 0;
  const withoutRequires = code.replace(pattern, (_match, varName, modPath) => {
    // These runtime helpers are TS-compiled CJS (`exports.default = fn`, __esModule flag set).
    // Node's CJS→ESM interop for such modules has a documented quirk: when a named export
    // literally called "default" is statically detected (as it is here), `ns.default` resolves
    // to the *whole* module.exports object — not to `exports.default` — so the real function
    // sits one level deeper, at `ns.default.default`. A plain `import fn from "...js"` or
    // `import { default as fn }` both land on that wrapper object, not the function; verified
    // empirically against this exact module rather than assumed.
    const ns = `__runtime_ns_${n++}`;
    imports.push(`import * as ${ns} from "${modPath}.js";`);
    consts.push(`const ${varName} = ${ns}.default.default;`);
    return '';
  });
  if (imports.length === 0) return code;
  return imports.join('\n') + '\n' + consts.join('\n') + '\n' + withoutRequires;
}

function findDatamodelCodegen(): [string, ...string[]] {
  // Preference order: the gateway's own venv (created per docs/CURRENT_BUILD.md since `uv` is
  // not installed in every environment) → uv's ephemeral runner → whatever is on PATH.
  const venvBin = path.join(
    root, '..', '..', 'server', 'gateway', '.venv', 'bin', 'datamodel-codegen',
  );
  try {
    execFileSync(venvBin, ['--version']);
    return [venvBin];
  } catch { /* fall through */ }
  try {
    execFileSync('uvx', ['--version']);
    return ['uvx', '--with', 'datamodel-code-generator', 'datamodel-codegen'];
  } catch { /* fall through */ }
  return ['datamodel-codegen'];
}

function generatePydanticModels() {
  mkdirSync(gatewayProtocolDir, { recursive: true });
  const runner = findDatamodelCodegen();
  const files = readdirSync(schemaDir).filter((f) => f.endsWith('.schema.json'));
  for (const file of files) {
    const outName = file.replace('.schema.json', '.py').replace(/-/g, '_');
    const args = [
      ...runner.slice(1),
      '--input', path.join(schemaDir, file),
      '--input-file-type', 'jsonschema',
      '--output', path.join(gatewayProtocolDir, outName),
      '--output-model-type', 'pydantic_v2.BaseModel',
      '--use-schema-description',
      '--disable-timestamp',
      '--collapse-root-models',
      '--strict-nullable',
      '--target-python-version', '3.12',
    ];
    try {
      execFileSync(runner[0], args, { stdio: 'inherit' });
    } catch (err) {
      console.warn(
        `[protocol] Pydantic generation for ${file} failed — no working ` +
        `datamodel-code-generator found (tried gateway .venv, uvx, PATH). Install it into ` +
        `server/gateway/.venv (pip install datamodel-code-generator) or install uv. Error: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  const initPath = path.join(gatewayProtocolDir, '__init__.py');
  const banner = '"""GENERATED — do not hand-edit. Run `pnpm gen:protocol` to regenerate."""\n';
  writeFileSync(initPath, banner);
}

async function main() {
  await generateTypeScriptTypes();
  generateValidators();
  generatePydanticModels();
  console.log('[protocol] generation complete');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

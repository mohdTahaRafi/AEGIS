/**
 * T-1.7: every sample in samples/manifest.json produces the same verdict — and, for violations,
 * the same named field — on both the TypeScript validator and the Python Pydantic models
 * (see test_contract.py in server/gateway/tests for the Python half). Run together they prove
 * the contract, not just this half of it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  validateActionPlan,
  validateErrorResponse,
  validateSanitizedContext,
  validateSessionCreate,
  validateSessionCreated,
} from '../../src/generated/validators.js';
import type { AjvValidateFunction } from '../../src/generated/validators.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const samplesDir = path.join(__dirname, 'samples');

const VALIDATORS: Record<string, AjvValidateFunction> = {
  sanitizedContext: validateSanitizedContext,
  actionPlan: validateActionPlan,
  errorResponse: validateErrorResponse,
  sessionCreate: validateSessionCreate,
  sessionCreated: validateSessionCreated,
};

interface AjvExpect {
  keyword: string;
  instancePath: string;
  additionalProperty?: string;
}

interface ManifestEntry {
  file: string;
  schema: string;
  note?: string;
  ajv?: AjvExpect;
}

interface Manifest {
  valid: ManifestEntry[];
  violation: ManifestEntry[];
}

function loadJson<T>(relPath: string): T {
  return JSON.parse(readFileSync(path.join(samplesDir, relPath), 'utf8')) as T;
}

const manifest = loadJson<Manifest>('manifest.json');

describe('contract round-trip — valid samples', () => {
  for (const entry of manifest.valid) {
    it(`${entry.file} validates against ${entry.schema}`, () => {
      const data = loadJson<unknown>(entry.file);
      const validator = VALIDATORS[entry.schema];
      const ok = validator(data);
      if (!ok) {
        throw new Error(
          `expected valid, got errors: ${JSON.stringify(validator.errors)}`,
        );
      }
      expect(ok).toBe(true);
    });
  }
});

describe('contract round-trip — violation samples', () => {
  for (const entry of manifest.violation) {
    it(`${entry.file} is rejected by ${entry.schema}, naming the expected field`, () => {
      const data = loadJson<unknown>(entry.file);
      const validator = VALIDATORS[entry.schema];
      const ok = validator(data);
      expect(ok, `expected ${entry.file} to be rejected but it validated`).toBe(false);

      const ajvExpect = entry.ajv;
      if (!ajvExpect) throw new Error(`manifest entry for ${entry.file} has no ajv matcher`);

      const errors = validator.errors ?? [];
      const found = errors.some((e) => {
        if (e.keyword !== ajvExpect.keyword) return false;
        if (e.instancePath !== ajvExpect.instancePath) return false;
        if (ajvExpect.additionalProperty !== undefined) {
          const params = e.params as { additionalProperty?: string } | undefined;
          if (params?.additionalProperty !== ajvExpect.additionalProperty) return false;
        }
        return true;
      });

      if (!found) {
        throw new Error(
          `expected an error matching ${JSON.stringify(ajvExpect)} in ` +
          `${JSON.stringify(errors, null, 2)}`,
        );
      }
    });
  }
});

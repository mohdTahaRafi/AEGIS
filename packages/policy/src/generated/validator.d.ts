// GENERATED FILE — do not hand-edit. Run `npx tsx scripts/generate-validator.ts` to regenerate.
// Standalone Ajv validator (no Ajv compiler shipped in the bundle — see this script's header comment).
export interface AjvErrorObject {
  keyword: string;
  instancePath: string;
  message?: string;
  params: Record<string, unknown>;
}
export type AjvValidateFunction = ((data: unknown) => boolean) & {
  errors?: AjvErrorObject[] | null;
};
export declare const validatePolicy: AjvValidateFunction;

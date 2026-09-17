// GENERATED FILE — do not hand-edit. Run `pnpm gen:protocol` to regenerate.
// Standalone Ajv validators (no Ajv compiler shipped in the bundle).
export interface AjvErrorObject {
  keyword: string;
  instancePath: string;
  message?: string;
  params: Record<string, unknown>;
}
export type AjvValidateFunction = ((data: unknown) => boolean) & {
  errors?: AjvErrorObject[] | null;
};
export declare const validateSanitizedContext: AjvValidateFunction;
export declare const validateActionPlan: AjvValidateFunction;
export declare const validateErrorResponse: AjvValidateFunction;
export declare const validateSessionCreate: AjvValidateFunction;
export declare const validateSessionCreated: AjvValidateFunction;

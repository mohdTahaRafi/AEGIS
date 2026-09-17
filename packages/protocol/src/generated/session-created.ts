// GENERATED FILE — do not hand-edit. Run `pnpm gen:protocol` to regenerate.
// Source: packages/protocol/schema/

export interface SessionCreated {
  /**
   * UUIDv4-shaped. A pattern, not format:uuid, so the standalone Ajv validator needs no runtime format module.
   */
  session_id: string;
  model: string;
  limits: {
    max_steps: number;
    max_image_px: number;
  };
}

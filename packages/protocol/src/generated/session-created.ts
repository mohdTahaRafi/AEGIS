// GENERATED FILE — do not hand-edit. Run `pnpm gen:protocol` to regenerate.
// Source: packages/protocol/schema/

export interface SessionCreated {
  /**
   * UUIDv4-shaped. A pattern, not format:uuid, so the standalone Ajv validator needs no runtime format module.
   */
  session_id: string;
  model: string;
  /**
   * The gateway's own serving mode (config.py's AEGIS_MODE), told to the client at session open so the panel can show real connection state instead of a placeholder (T-2.39).
   */
  mode: "live" | "record" | "replay";
  limits: {
    max_steps: number;
    max_image_px: number;
  };
}

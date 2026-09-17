// GENERATED FILE — do not hand-edit. Run `pnpm gen:protocol` to regenerate.
// Source: packages/protocol/schema/

export interface SessionCreate {
  schema: "AEGIS/1";
  client: {
    browser: "chrome" | "firefox";
    extension_version: string;
    backend: "webgpu" | "wasm";
    detectors: {
      [k: string]: string;
    };
    policy: string;
    capabilities: {
      l1_image?: boolean;
      l2_crop?: boolean;
      click_point?: boolean;
    };
  };
}

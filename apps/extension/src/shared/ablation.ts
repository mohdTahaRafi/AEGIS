// design.md §18.3, T-6.9/T-6.10 — the four ablation arms' shared type. Lives in `shared/`, not
// `debug/`, because `host/session.ts`/`host/privacy/context/builder.ts`/`host/perception-client/
// run-step.ts` all need it as ordinary data — only the SWITCH that PICKS an arm at runtime
// (`debug/ablations.ts`) is debug-build-only; the host/perception code that *handles* a given
// arm is normal, always-compiled-in parameterized code (the same shape `SessionDeps.canaries?`
// already uses for the eval harness's own debug-only input). A release build never calls the
// switch, so `ablation` is always `undefined` (→ `'fused'`) there — no source-level "if debug"
// branching is needed in host/perception code, only in the one file that reads the switch.
export type AblationArm = 'fused' | 'dom_only' | 'pixel_only' | 'blackbox';

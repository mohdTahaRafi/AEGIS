// design.md §13.5 (FR-35, T-6.11) — the settings row table, stored in `storage.local`. "Settings
// are stored in storage.local; they never contain vault values or captures" is the AC this module
// exists to satisfy: `Settings` below has no field that could ever hold a vault value or a
// capture, by construction (server URL/token, backend/NER/policy choices and two booleans are all
// it stores).

import type { EntityType } from '@aegis/recognizers';
import type { Policy } from '@aegis/policy';
import { DEFAULT_MODEL_NAME, DEFAULT_MODEL_URL } from '../egress/model-client';

export type BackendPref = 'auto' | 'webgpu' | 'wasm';
export type NerProfile = 'S' | 'L';

/** design.md §13.5's "Per-type redaction policy (Tier 2)" row: `true` forces an entity type to
 * always be treated as the policy's most sensitive class (`CRITICAL`), overriding whatever class
 * the base policy would otherwise assign it — "follow policy" is simply the entity's absence (or
 * `false`) here. Kept as a flat per-entity map rather than a new policy document because the base
 * policy stays the single source of truth for every entity this override doesn't touch. */
export type AlwaysRedactMap = Partial<Record<EntityType, boolean>>;

export interface Settings {
  /** The user's own model API key (bring your own key). Kept only in this browser's extension
   * storage; it goes to the model API and nowhere else, and is never logged. */
  apiKey: string;
  /** Development builds only: the OpenAI-compatible endpoint and model the key is used with. A
   * release build always uses Groq's (`resolveModelConfig`). */
  modelUrl: string;
  modelName: string;
  /** Development/eval builds only: the legacy server gateway, used when no `apiKey` is set. */
  serverUrl: string;
  accessToken: string;
  backend: BackendPref;
  nerProfile: NerProfile;
  /** Only "default" exists today (design.md §13.5: "default (others only if the team defines
   * them)") — kept as a string, not a union of one, so a future second policy document needs no
   * type change here. */
  policyId: string;
  debugOverlay: boolean;
  showRawPayload: boolean;
  alwaysRedact: AlwaysRedactMap;
}

const STORAGE_KEY = 'aegis_settings';

export interface SettingsStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** `serverUrl`/`accessToken` default to the build-time values (design.md: "build-time value") —
 * the caller passes whatever `main.tsx` already resolves those from today, so a fresh install
 * with no saved settings behaves exactly as it did before this module existed. */
export function defaultSettings(buildTimeServerUrl: string, buildTimeAccessToken: string): Settings {
  return {
    apiKey: '',
    modelUrl: DEFAULT_MODEL_URL,
    modelName: DEFAULT_MODEL_NAME,
    serverUrl: buildTimeServerUrl,
    accessToken: buildTimeAccessToken,
    backend: 'auto',
    nerProfile: 'S',
    policyId: 'default',
    debugOverlay: false,
    showRawPayload: true, // design.md: "on (demo)"
    alwaysRedact: {},
  };
}

function isPartialSettings(value: unknown): value is Partial<Settings> {
  return typeof value === 'object' && value !== null;
}

export async function loadSettings(storage: SettingsStorageArea, defaults: Settings): Promise<Settings> {
  const stored = await storage.get(STORAGE_KEY);
  const raw = stored[STORAGE_KEY];
  if (!isPartialSettings(raw)) return defaults;
  // Shallow-merged over `defaults` field by field (not `{...defaults, ...raw}`) so a settings
  // blob saved by an older build that's missing a newly-added field (e.g. `alwaysRedact`) still
  // gets that field's default instead of `undefined`.
  return {
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : defaults.apiKey,
    modelUrl: raw.modelUrl ?? defaults.modelUrl,
    modelName: raw.modelName ?? defaults.modelName,
    serverUrl: raw.serverUrl ?? defaults.serverUrl,
    accessToken: raw.accessToken ?? defaults.accessToken,
    backend: raw.backend ?? defaults.backend,
    nerProfile: raw.nerProfile ?? defaults.nerProfile,
    policyId: raw.policyId ?? defaults.policyId,
    debugOverlay: raw.debugOverlay ?? defaults.debugOverlay,
    showRawPayload: raw.showRawPayload ?? defaults.showRawPayload,
    alwaysRedact: raw.alwaysRedact ?? defaults.alwaysRedact,
  };
}

export async function saveSettings(storage: SettingsStorageArea, settings: Settings): Promise<void> {
  await storage.set({ [STORAGE_KEY]: settings });
}

/** Returns `policy` unchanged when there is nothing to override (the common case) rather than
 * always cloning, so a session that never touched Settings pays no extra allocation. */
export function applyAlwaysRedact(policy: Policy, alwaysRedact: AlwaysRedactMap): Policy {
  const forced = (Object.keys(alwaysRedact) as EntityType[]).filter((entity) => alwaysRedact[entity]);
  if (forced.length === 0) return policy;
  const entityClass = { ...policy.entityClass };
  for (const entity of forced) entityClass[entity] = 'CRITICAL';
  return { ...policy, entityClass };
}

/** What a pasted key needs before it is stored: surrounding whitespace, quotes and a stray
 * `Bearer ` prefix are copy-paste noise, not part of the key. */
export function cleanApiKey(input: string): string {
  return input.trim().replace(/^["']|["']$/g, '').replace(/^Bearer\s+/i, '').trim();
}

/** A shape check only (Groq keys are `gsk_` plus ~50 characters): "Test key" is what proves a key
 * works. */
export function looksLikeApiKey(key: string): boolean {
  return /^[A-Za-z0-9_-]{20,}$/.test(key);
}

/** The endpoint, model and key a task talks to. A release build ignores any stored endpoint or
 * model: the key is only ever sent to Groq. */
export function resolveModelConfig(settings: Settings, release: boolean): { apiKey: string; baseUrl: string; model: string } {
  return {
    apiKey: settings.apiKey,
    baseUrl: release ? DEFAULT_MODEL_URL : settings.modelUrl || DEFAULT_MODEL_URL,
    model: release ? DEFAULT_MODEL_NAME : settings.modelName || DEFAULT_MODEL_NAME,
  };
}

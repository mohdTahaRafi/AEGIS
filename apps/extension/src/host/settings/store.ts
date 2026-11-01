// design.md §13.5 (FR-35, T-6.11) — the settings row table, stored in `storage.local`. "Settings
// are stored in storage.local; they never contain vault values or captures" is the AC this module
// exists to satisfy: `Settings` below has no field that could ever hold a vault value or a
// capture, by construction (server URL/token, backend/NER/policy choices and two booleans are all
// it stores).

import type { EntityType } from '@aegis/recognizers';
import type { Policy } from '@aegis/policy';
import { DEFAULT_PROVIDER, PROVIDERS, isProviderId, type ProviderId } from '../egress/providers';

export type BackendPref = 'auto' | 'webgpu' | 'wasm';
export type NerProfile = 'S' | 'L';

/** design.md §13.5's "Per-type redaction policy (Tier 2)" row: `true` forces an entity type to
 * always be treated as the policy's most sensitive class (`CRITICAL`), overriding whatever class
 * the base policy would otherwise assign it — "follow policy" is simply the entity's absence (or
 * `false`) here. Kept as a flat per-entity map rather than a new policy document because the base
 * policy stays the single source of truth for every entity this override doesn't touch. */
export type AlwaysRedactMap = Partial<Record<EntityType, boolean>>;

export interface Settings {
  /** Which model API the user's key is for (egress/providers.ts). */
  provider: ProviderId;
  /** The user's own API key per provider (bring your own key). Kept only in this browser's
   * extension storage; each goes to its own provider's API and nowhere else, and is never logged. */
  apiKeys: Partial<Record<ProviderId, string>>;
  /** The model chosen per provider (by "Test key", or by the user); absent = the preset's first. */
  models: Partial<Record<ProviderId, string>>;
  /** Development builds only: an OpenAI-compatible endpoint and model overriding the provider's.
   * Empty = use the provider's. A release build ignores both (`resolveModelConfig`). */
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
    provider: DEFAULT_PROVIDER,
    apiKeys: {},
    models: {},
    modelUrl: '',
    modelName: '',
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
  const raw = stored[STORAGE_KEY] as (Partial<Settings> & { apiKey?: unknown }) | undefined;
  if (!isPartialSettings(raw)) return defaults;
  const apiKeys: Partial<Record<ProviderId, string>> = {};
  if (isPartialSettings(raw.apiKeys)) {
    for (const [id, key] of Object.entries(raw.apiKeys)) if (isProviderId(id) && typeof key === 'string' && key) apiKeys[id] = key;
  }
  // Builds before provider choice stored one Groq key as `apiKey`: it stays the active key.
  const legacyKey = typeof raw.apiKey === 'string' && raw.apiKey ? raw.apiKey : undefined;
  if (legacyKey && !apiKeys.groq) apiKeys.groq = legacyKey;
  const provider = isProviderId(raw.provider) ? raw.provider : legacyKey ? 'groq' : defaults.provider;
  const models: Partial<Record<ProviderId, string>> = {};
  if (isPartialSettings(raw.models)) {
    for (const [id, model] of Object.entries(raw.models)) if (isProviderId(id) && typeof model === 'string' && model) models[id] = model;
  }
  // Older builds stored Groq's endpoint and model as the "override": they were the defaults then.
  const legacyDefault = (url: unknown) => url === PROVIDERS.groq.baseUrl || url === PROVIDERS.groq.models[0]!.id;
  // Shallow-merged over `defaults` field by field (not `{...defaults, ...raw}`) so a settings
  // blob saved by an older build that's missing a newly-added field still gets that field's default.
  return {
    provider,
    apiKeys,
    models,
    modelUrl: typeof raw.modelUrl === 'string' && !legacyDefault(raw.modelUrl) ? raw.modelUrl : defaults.modelUrl,
    modelName: typeof raw.modelName === 'string' && !legacyDefault(raw.modelName) ? raw.modelName : defaults.modelName,
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

/** The saved key for the chosen provider, or ''. */
export function activeApiKey(settings: Settings): string {
  return settings.apiKeys[settings.provider] ?? '';
}

/** `settings` with `key` saved (or removed, for '') as the chosen provider's key. */
export function withApiKey(settings: Settings, key: string): Settings {
  const apiKeys = { ...settings.apiKeys };
  if (key) apiKeys[settings.provider] = key;
  else delete apiKeys[settings.provider];
  return { ...settings, apiKeys };
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

/** A shape check only: "Test key" is what proves a key works. */
export function looksLikeApiKey(key: string): boolean {
  return /^[A-Za-z0-9_.-]{20,}$/.test(key);
}

export interface ResolvedModelConfig {
  provider: ProviderId;
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** The provider, endpoint, model and key a task talks to. A release build ignores any stored
 * endpoint override: the key only ever goes to its own provider's API. */
export function resolveModelConfig(settings: Settings, release: boolean, apiKey = activeApiKey(settings)): ResolvedModelConfig {
  const preset = PROVIDERS[settings.provider];
  const chosen = settings.models[settings.provider] || preset.models[0]!.id;
  return {
    provider: preset.id,
    apiKey,
    baseUrl: release ? preset.baseUrl : settings.modelUrl || preset.baseUrl,
    model: release ? chosen : settings.modelName || chosen,
  };
}

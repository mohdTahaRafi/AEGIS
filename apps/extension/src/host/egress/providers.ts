// The model APIs a user's own key may be for. Every one serves a vision model through an
// OpenAI-compatible chat-completions endpoint, on a free tier. Closed-weights models (Gemini) are
// allowed: the open-weights constraint C-2 was lifted by the product owner on 2026-10-10, for now.
// This file is the single list: the manifest's host permissions and CSP (wxt.config.ts), the
// release gate (scripts/verify-release.ts), the settings UI and the model client all read it, so a
// build can only ever talk to an origin named here. Pure data: no browser APIs.

export type ProviderId = 'mistral' | 'gemini' | 'groq' | 'openrouter';

/** How the model writes `click_point` coordinates. `norm1000-long`: both axes in 0-1000 units of
 * the image's long side (measured for qwen3.8 on Groq). `norm1000-axis`: x in 0-1000 of the width,
 * y in 0-1000 of the height (Gemini's documented convention). `image-px`: pixels of the image as sent. */
export type Grounding = 'norm1000-long' | 'norm1000-axis' | 'image-px';

/** `compact` fits an ~8K tokens/minute budget (little page text); `rich` sends the page's text,
 * a larger element list, and allows long answers. */
export type PromptProfile = 'compact' | 'rich';

export interface ProviderPreset {
  id: ProviderId;
  label: string;
  /** One line for the settings UI: what the free tier allows. */
  freeTier: string;
  baseUrl: string;
  origin: string;
  keysUrl: string;
  keyPlaceholder: string;
  /** Tried in order when the key is checked; the first one the key can use (and, where the API
   * says so, that takes images) is chosen. The first entry is the default before any check.
   * `params` override `extraParams` for that model. */
  models: readonly { id: string; label: string; params?: Readonly<Record<string, unknown>> }[];
  /** Fields this API needs on every request beyond the OpenAI basics. */
  extraParams: Readonly<Record<string, unknown>>;
  /** Overrides the client's default sampling temperature. */
  temperature?: number;
  /** Each model has its own daily request quota: when one is used up the client moves on to the
   * next model in `models` for the rest of the day instead of stopping the task. */
  perModelDailyQuota?: boolean;
  /** Better-judgement models for the steps that need it (planning, recovering, correcting), tried
   * in order before the user's model; used up or unavailable, the step goes to the user's model. */
  smartModels?: readonly string[];
  grounding: Grounding;
  profile: PromptProfile;
  maxTokens: number;
  /** What one screenshot costs against a per-minute token budget (only used when the API reports
   * its budget in response headers). */
  imageTokens: number;
  /** The free tier's terms allow the provider to train on requests (they are already redacted). */
  freeTierMayTrain: boolean;
}

export const PROVIDERS: Readonly<Record<ProviderId, ProviderPreset>> = {
  mistral: {
    id: 'mistral',
    label: 'Mistral',
    freeTier: 'Needs the "Experiment" plan (free, phone check) activated in the console; an account on the plain Free plan cannot create API keys. Then about 1 request/s, 500K tokens/min',
    baseUrl: 'https://api.mistral.ai/v1',
    origin: 'https://api.mistral.ai',
    keysUrl: 'https://console.mistral.ai/api-keys',
    keyPlaceholder: 'Mistral API key',
    models: [
      { id: 'mistral-large-latest', label: 'Mistral Large (best)' },
      { id: 'mistral-medium-latest', label: 'Mistral Medium (balanced)' },
      { id: 'mistral-small-latest', label: 'Mistral Small (fast)' },
      { id: 'ministral-14b-latest', label: 'Ministral 14B (fastest)' },
    ],
    extraParams: {},
    grounding: 'image-px',
    profile: 'rich',
    maxTokens: 2000,
    imageTokens: 3000,
    freeTierMayTrain: true,
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini (recommended)',
    freeTier:
      'Free tier (Google AI Studio key, no card): about 500 requests/day for each Flash-Lite model and 20/day for each Flash model; AEGIS moves on to the next model when one runs out',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    origin: 'https://generativelanguage.googleapis.com',
    keysUrl: 'https://aistudio.google.com/apikey',
    keyPlaceholder: 'AIza…',
    // Fastest first. Measured 2026-10-10 on the free tier, one redacted Wikipedia step (5.8K tokens
    // in, screenshot included): 3.5 Flash-Lite 2.4-2.6 s, 3.1 Flash-Lite 2.6 s, 3.5 Flash 3.9 s,
    // 3.6 Flash 4.3 s, all correct. 3.8 Flash took 42-91 s on the free tier and is left out.
    models: [
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite (fastest, ~500/day)', params: { reasoning_effort: 'minimal' } },
      { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite (fast, ~500/day)', params: { reasoning_effort: 'minimal' } },
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash (smarter, ~20/day)' },
      { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash (smarter, ~20/day)' },
    ],
    // Gemini 3 cannot turn thinking off. Flash-Lite takes "minimal"; Flash models reject it, so they
    // get "low". Google advises leaving Gemini 3 at temperature 1.0 (lower values can make it loop).
    extraParams: { reasoning_effort: 'low' },
    temperature: 1,
    perModelDailyQuota: true,
    // About 20 free requests a day each: spent only on planning and recovery steps.
    smartModels: ['gemini-3.6-flash', 'gemini-3.5-flash'],
    grounding: 'norm1000-axis',
    profile: 'rich',
    // Gemini counts thinking tokens inside max_tokens.
    maxTokens: 4000,
    imageTokens: 1600,
    freeTierMayTrain: true,
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    freeTier: 'Free plan: ~6-8K tokens/min and ~200K tokens/day for the vision model (about one step every 40 s)',
    baseUrl: 'https://api.groq.com/openai/v1',
    origin: 'https://api.groq.com',
    keysUrl: 'https://console.groq.com/keys',
    keyPlaceholder: 'gsk_…',
    models: [{ id: 'qwen/qwen3.8-27b', label: 'Qwen 3.8 27B (vision)' }],
    // Thinking off: hidden reasoning tokens count against the small quota.
    extraParams: { reasoning_effort: 'none' },
    grounding: 'norm1000-long',
    profile: 'compact',
    maxTokens: 900,
    imageTokens: 3600,
    freeTierMayTrain: false,
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter (free models)',
    freeTier: 'Free models: 20 requests/min, 50 requests/day (1,000/day after a one-time $10 top-up)',
    baseUrl: 'https://openrouter.ai/api/v1',
    origin: 'https://openrouter.ai',
    keysUrl: 'https://openrouter.ai/settings/keys',
    keyPlaceholder: 'sk-or-…',
    models: [
      { id: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B (free)' },
      { id: 'google/gemma-4-26b-a4b-it:free', label: 'Gemma 4 26B A4B (free, faster)' },
    ],
    extraParams: {},
    grounding: 'image-px',
    profile: 'rich',
    maxTokens: 2000,
    imageTokens: 1500,
    freeTierMayTrain: true,
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];
// Gemini Flash-Lite: free with no card, and the fastest measured (2026-10-10, visible Wikipedia
// task: 2 steps in 13.9 s, model 2.2-4.0 s per step; Groq 51 s, most of it free-tier pacing).
// Mistral's console gives a Free-plan account no API key without activating a plan.
export const DEFAULT_PROVIDER: ProviderId = 'gemini';

/** Every origin a release build may connect to besides itself. */
export const MODEL_API_ORIGINS: readonly string[] = PROVIDER_IDS.map((id) => PROVIDERS[id].origin);

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as string[]).includes(value);
}

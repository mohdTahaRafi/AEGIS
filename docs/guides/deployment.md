# Deployment

AEGIS ships as **one browser extension and nothing else**. There is no server to run and nothing to
download after installing:

- every on-device model (face, OCR, image screening) is inside the package and checked against a pinned
  sha256 at build time;
- the model that plans each step is a vision model on the provider the user picks (Google Gemini by
  default; Groq, Mistral or OpenRouter's free models), called straight from the extension with **the
  user's own API key** (bring your own key). The team's key is not part of the product.

```
user's browser ── AEGIS extension ──(redacted prompt + screenshot, user's key)──▶ the chosen provider's API
                  └ models, vault, guard, plan validation all run here
```

The provider list is one file, [`apps/extension/src/host/egress/providers.ts`](../../apps/extension/src/host/egress/providers.ts):
the manifest's host permissions and CSP, the release gate, the settings UI and the model client all read
it, so a build can only talk to an origin named there.

## What a release contains

| | |
|---|---|
| Package | `aegis-<version>-chrome.zip` / `-firefox.zip`, ~86 MB (139 MB unpacked, mostly the CLIP screener 89 MB and the ONNX Runtime WebAssembly binary 28 MB) |
| On-device models | YuNet face detector, PP-OCRv5 text detector + English and Devanagari recognizers, CLIP ViT-B/32 (int8) and its prompt embeddings. Exactly the files in `apps/extension/public/models/models.manifest.json`, nothing else |
| Network access | Extension pages may connect only to themselves and the four model APIs (manifest CSP `connect-src`): `generativelanguage.googleapis.com`, `api.groq.com`, `api.mistral.ai`, `openrouter.ai` |
| Site access | `<all_urls>` is a **required** host permission: an optional one, even switched to "On all sites", never lets `captureVisibleTab` work (measured 2026-10-10, Chromium 153). A user who restricts it to "On click" gets the `activeTab` path via the toolbar icon |
| Not included | The optional 950 MB free-text NER model (profile L). It is dev-only; a release always uses the lightweight profile, and the setting is hidden |

## Build a release

Prerequisites: Node ≥ 22, pnpm.

```bash
pnpm install --frozen-lockfile

# 1. Get the models into apps/extension/public/models/ (gitignored, never hand-committed)
cd apps/extension
pnpm exec tsx scripts/fetch-models.ts          # face + OCR: downloaded, sha256-verified
# CLIP ViT + prompt embeddings have no download URL; generate them once (needs Python + torch):
#   tools/models/export_vit_vision.py, quantize.py, export_vit_prompts.py  (recipe: docs in models.manifest.json "source")
# CI does exactly this and caches the result (.github/workflows/ci.yml).

# 2. Build, check, zip
pnpm build                # Chrome  -> .output/chrome-mv3
pnpm build:firefox        # Firefox -> .output/firefox-mv3
pnpm zip                  # -> .output/aegis-<version>-chrome.zip
pnpm zip:firefox          # -> .output/aegis-<version>-firefox.zip (+ -sources.zip for AMO review)
```

`build` and `zip` refuse to finish unless both release gates pass:

1. **`verify:models`** (before): every model in the manifest is on disk with its pinned size and
   sha256. A missing or altered model stops the build, so it cannot become a load error on a user's
   machine.
2. **`verify:release`** (after, `scripts/verify-release.ts`): the built package has manifest v3, icons,
   exactly site access plus the model-API host permissions and the locked-down CSP, every model intact and *no other
   file* in `models/`, the ONNX Runtime WASM binary, no source maps, and none of the development-only
   strings (the legacy gateway URL and token, CDN URLs, the ablation switch).

Bump `version` in `apps/extension/package.json` before a store submission.

## Publish

**Chrome Web Store** — upload `aegis-<version>-chrome.zip`. Permission justifications to enter:

| Permission | Why |
|---|---|
| `activeTab` | screenshot of the tab the user invoked AEGIS on when site access is restricted to "On click" (the toolbar click grants it) |
| `scripting`, `tabs` | inject the page reader into the task's tab and follow tabs the task opens |
| `storage` | the user's settings and API key, in this browser only |
| `sidePanel` | the AEGIS panel |
| host `<all_urls>` | read and screenshot the task's own tab, on whichever site the task moves to |
| host `https://generativelanguage.googleapis.com/*`, `https://api.groq.com/*`, `https://api.mistral.ai/*`, `https://openrouter.ai/*` | send the redacted step to the provider the user chose, with the user's key |

The store listing needs a privacy policy: use [PRIVACY.md](../../PRIVACY.md). Listing copy and
screenshots are in [`store-listing/`](../../store-listing/).

**Firefox (AMO)** — upload `aegis-<version>-firefox.zip` and `-sources.zip`. Firefox 128+ is required
(`AbortSignal.any`). Firefox has not been driven end to end in automation in this environment (see the
README's known limitations); load the build by hand once before submitting.

## What the user does

1. Install the extension.
2. Open the AEGIS panel. The first thing it shows is the API-key card. Pick a provider (Google Gemini
   is preselected; a key comes from <https://aistudio.google.com/apikey>), paste the key, **Save key**.
   "Test key" asks the provider whether the key works and picks the best vision model it can use; a
   rejected key is never saved.
3. Type a task and **Run**.

The key lives in the extension's own storage, is sent only to that provider's API, is never logged, and
can be removed in Settings. Usage is limited by, or billed to, the user's own account with that provider.

## Free-tier limits users will meet

**Gemini** (default): each model has its own daily quota, roughly 500 requests/day per Flash-Lite model
and 20/day per Flash model (Google shows the exact figures only inside AI Studio). When one model's
quota runs out the client moves to the next model in the preset for the rest of the day instead of
stopping the task.

**Groq** (figures below):

The free tier limits tokens per minute (~8K per model), per day (~200K per organization) and requests.
One step with a screenshot costs ~5–7K tokens, so on the free tier steps are spaced about a minute
apart and a day allows very roughly 30–40 steps. The extension paces itself from Groq's
`x-ratelimit-*` headers and waits out a `429` for the `Retry-After` Groq names, instead of failing; a
paid Groq plan removes the wait. If a daily limit is hit the panel says so and the task stops. A rejected
key stops with `API_KEY_REJECTED`. (Figures measured on 2026-09-28 and 2026-09-30, see
`docs/planning/bugs/`.)

## Verify a build

```bash
# unit tests, types, lint, the no-network-outside-egress rule
pnpm -r typecheck && pnpm lint && pnpm --filter @aegis/extension test

# the release package as a user gets it, network locked to the demo page + api.groq.com
# (this smoke test still exercises the Groq path only: docs/planning/bugs/tasks.md, CLEAN-1)
python3 -m http.server 8080 --bind 127.0.0.1 --directory demo &
eval/.venv/bin/python tools/e2e/release_smoke.py             # Groq's answer scripted, 16 checks
eval/.venv/bin/python tools/e2e/release_smoke.py --live      # one real Groq call with your key
```

`release_smoke.py` proves: first run asks for a key; a malformed key is refused locally and a wrong one
by Groq without being saved; with a key, a task runs end to end with the face, OCR and CLIP models
loaded from the package; the request carries a redacted screenshot and no raw sensitive value; the
saved key goes to `api.groq.com` and nowhere else; nothing else on the network was contacted.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Task box is greyed out, API-key card shown | no key saved yet — paste one |
| `API_KEY_REJECTED` | the provider refused the key (revoked, mistyped, other account): Settings → new key |
| "cannot see the vision model" after saving | the account cannot use any of the preset's vision models: check its plan in the provider's console |
| `MODEL_UNAVAILABLE upstream_429 retry in N s` | the provider's per-minute or daily limit: wait, switch provider, or use a key with more quota |
| `MODEL_UNAVAILABLE upstream_too_large` | the page is too big for the account's per-minute input limit even after shrinking the prompt |
| `PAGE_NOT_CONNECTED` | click the AEGIS toolbar icon while the page is in front (or reload it), then Run |
| `pnpm build` stops with "release blocked: bundled models are not intact" | a model file is missing or altered: re-run the model step above |

## Legacy: the server gateway (development and evaluation only)

`server/gateway` (FastAPI) is the pre-release architecture, kept for the evaluation harness's mock
gateway, the offline replay demo and older dev runs. **A release build never uses it.** A development
build (`pnpm dev`, `wxt build --mode development`) still talks to it when no API key is saved, and
talks to the model directly when one is. See [server/deploy/README.md](../../server/deploy/README.md) for its
own setup; its `model.env` key is for that server only.

# Deployment

AEGIS ships as **one browser extension and nothing else**. There is no server to run and nothing to
download after installing:

- every on-device model (face, OCR, image screening) is inside the package and checked against a pinned
  sha256 at build time;
- the model that plans each step is on Groq, called straight from the extension with **the user's own
  API key** (bring your own key). The team's key is not part of the product.

```
user's browser ── AEGIS extension ──(redacted prompt + screenshot, user's key)──▶ api.groq.com
                  └ models, vault, guard, plan validation all run here
```

## What a release contains

| | |
|---|---|
| Package | `aegis-<version>-chrome.zip` / `-firefox.zip`, ~86 MB (139 MB unpacked, mostly the CLIP screener 89 MB and the ONNX Runtime WebAssembly binary 28 MB) |
| On-device models | YuNet face detector, PP-OCRv5 text detector + English and Devanagari recognizers, CLIP ViT-B/32 (int8) and its prompt embeddings. Exactly the files in `apps/extension/public/models/models.manifest.json`, nothing else |
| Network access | Extension pages may connect only to themselves and `https://api.groq.com` (manifest CSP `connect-src`). The one required host permission is `https://api.groq.com/*`; site access stays optional and user-granted |
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
   exactly the `api.groq.com` host permission and the locked-down CSP, every model intact and *no other
   file* in `models/`, the ONNX Runtime WASM binary, no source maps, and none of the development-only
   strings (the legacy gateway URL and token, CDN URLs, the ablation switch).

Bump `version` in `apps/extension/package.json` before a store submission.

## Publish

**Chrome Web Store** — upload `aegis-<version>-chrome.zip`. Permission justifications to enter:

| Permission | Why |
|---|---|
| `activeTab` | screenshot of the tab the user invoked AEGIS on (the toolbar click grants it) |
| `scripting`, `tabs` | inject the page reader into the task's tab and follow tabs the task opens |
| `storage` | the user's settings and API key, in this browser only |
| `sidePanel` | the AEGIS panel |
| host `https://api.groq.com/*` | send the redacted step to the model, with the user's key |
| optional `<all_urls>` | requested at Run, per site, only if the user allows |

The store listing needs a privacy policy: use [PRIVACY.md](PRIVACY.md).

**Firefox (AMO)** — upload `aegis-<version>-firefox.zip` and `-sources.zip`. Firefox 128+ is required
(`AbortSignal.any`). Firefox has not been driven end to end in automation in this environment (see the
README's known limitations); load the build by hand once before submitting.

## What the user does

1. Install the extension.
2. Open the AEGIS panel. The first thing it shows is **"Add your Groq API key to start"**. Create a key
   at <https://console.groq.com/keys>, paste it, **Save key**. AEGIS asks Groq whether the key works and
   whether it can use the vision model; a rejected key is never saved.
3. Type a task and **Run**. Allow site access when Chrome asks.

The key lives in the extension's own storage, is sent only to `api.groq.com`, is never logged, and can be
removed in Settings. Usage is billed to, or limited by, the user's Groq account.

## Groq limits users will meet

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
| Task box is greyed out, "Add your Groq API key" | no key saved yet — paste one |
| `API_KEY_REJECTED` | Groq refused the key (revoked, mistyped, other account): Settings → new key |
| "cannot see the vision model" after saving | the Groq account has no access to `qwen/qwen3.8-27b`: check the account/plan at console.groq.com |
| `MODEL_UNAVAILABLE upstream_429 retry in N s` | Groq's per-minute or daily token limit: wait, or use a key with more quota |
| `MODEL_UNAVAILABLE upstream_too_large` | the page is too big for the account's per-minute input limit even after shrinking the prompt |
| `PAGE_NOT_CONNECTED` | click the AEGIS toolbar icon while the page is in front (or reload it), then Run |
| `pnpm build` stops with "release blocked: bundled models are not intact" | a model file is missing or altered: re-run the model step above |

## Legacy: the server gateway (development and evaluation only)

`server/gateway` (FastAPI) is the pre-release architecture, kept for the evaluation harness's mock
gateway, the offline replay demo and older dev runs. **A release build never uses it.** A development
build (`pnpm dev`, `wxt build --mode development`) still talks to it when no API key is saved, and
talks to the model directly when one is. See [server/deploy/README.md](server/deploy/README.md) for its
own setup; its `model.env` key is for that server only.

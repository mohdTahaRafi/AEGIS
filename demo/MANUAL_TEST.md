# Manual test on any website

## 1. Start the gateway (terminal 1, leave it open)

```bash
cd AEGIS
server/deploy/run-gateway.sh
```

- Needs `server/deploy/model.env` (gitignored, `chmod 600`) containing `AEGIS_MODEL_API_KEY=gsk_...`
  (see `server/deploy/model.env.example`). Nothing else is required; the script sets the Groq
  URL, model (`qwen/qwen3.8-27b`), `AEGIS_MODE=live` and the token `dev-token`.
- Check it: `curl -s http://127.0.0.1:8787/readyz` must print `{"status":"ok"}` (Groq reachable
  **and** the key accepted). `not ready` = bad/revoked key or no internet.
- "address already in use": another gateway is running. Stop it with
  `pkill -f "aegis_gateway.main:ap[p]"` (run that command on its own), then start again.

## 2. Build and load the extension

```bash
cd AEGIS
pnpm install                                     # first time only
pnpm --filter @aegis/extension run build:debug   # -> apps/extension/.output/chrome-mv3-dev
```

Chrome → `chrome://extensions` → **Developer mode** on → **Load unpacked** →
`AEGIS/apps/extension/.output/chrome-mv3-dev`. Pin AEGIS (puzzle icon → pin).

Use the `-dev` build: it may screenshot any site without a per-site prompt. After every rebuild,
press the reload icon on the AEGIS card, then reload the web page you test on.

## 3. Configure (once)

Open the panel (next step) → **Settings**:

| Setting | Value |
|---|---|
| Server URL | `http://localhost:8787` |
| Access token | `dev-token` |
| Show raw payload | on (default) |

On the first **Run**, Chrome asks to let AEGIS "read and change all your data on all websites":
**Allow**. Chrome only lets an extension screenshot a tab it has all-sites access to, or a tab
where you clicked its icon, so without it a tab the task opens (a shop's product page) cannot be
screenshotted and the task stops (`VISION_UNAVAILABLE: … capture permission`). Declining keeps
AEGIS on per-site access; Setup then says so.

## 4. First run: Passport Seva (real site)

1. Open `https://services1.passportindia.gov.in/forms/PreLogin` and keep that tab in front.
2. Click the **AEGIS** toolbar icon: the side panel opens on the right.
3. Task: `Type test-user into the Login ID field. Do not press Continue.` → **Run**.

What you should see (verified live, 2026-09-29):

- **Perception (s-1): vision/CLIP**, `ran: CLIP ×6 · YuNet ×5 · OCR det ×5 …`,
  `crops: 5/5 analysed`, and one line per image (e.g. the passport picture: `CLIP "identity card"
  … ID_DOCUMENT … (redacted)`).
- **Activity**:
  `s-1: 2 operation(s) from the VLM`
  `1. type "test-user" → "Login ID *" ✓ executed`
  `2. done: Typed test-user into the Login ID field. ✓ executed`
- **Redactions: ID_DOCUMENT 2**, and **Protected fields (by label, before sending):
  USERNAME "Login ID *" (empty)**.
- The Login ID box on the page now shows `TEST-USER` (the site upper-cases it). Continue is not
  pressed.

The registration form (Login page → **Register here**) shows the semantic-label protection:
**Protected fields: PERSON_NAME "Full Name *" · EMAIL "Email ID *" · USERNAME "Login ID *" ·
PASSWORD "Password *"**. Type anything into those boxes yourself (even text that is not a valid
email/name) and run a task: they appear under **Redactions** as `PERSON_NAME · EMAIL · USERNAME ·
PASSWORD` and are sent only as `⟪PERSON_NAME#1⟫`, `⟪EMAIL#2⟫`, `⟪USERNAME#3⟫`; the password is
never read.

A task with no value to type (`Enter the username and click Sign in.` on that page) ends with
`MODEL_STOPPED: cannot_proceed (No username value was provided in the task to enter.)` after the
model clicks **Sign In**: a correct refusal, with the model's own reason.

Questions work too: on the registration page, `explain me what is this form about and what are
the details that i have to fill` → Activity `report ✓ executed` · `done ✓ executed` in one step
(~6 s, one Groq call); the answer is shown at the bottom of the panel, with filled fields referred
to only by placeholder.

## 5. Full type + click with a sealed value (demo page)

```bash
cd AEGIS && python3 -m http.server 8080 --bind 127.0.0.1 --directory demo
```

Open `http://127.0.0.1:8080/signin.html`, task `Enter the username and click Sign in.`

- Activity: `1. type ⟪USERNAME#2⟫ → "Username" ✓ executed` · `2. click → "Sign in" ✓ executed`
  · `3. done … ✓ executed`; the page shows **Signed in as rkumar_2291**.
- Redactions: `PERSON_NAME · USERNAME · AADHAAR · PAN · PHONE · EMAIL · FACE · PASSWORD`.
- The model only ever saw `⟪USERNAME#2⟫`; the extension typed the real value locally.

## 6. Other sites

Any normal `http(s)` page. Good tasks: `Search Wikipedia for Chandrayaan-3`, on
`https://html.duckduckgo.com/html/` `Search for ISRO launches`, on any article `Scroll down one
page`. Put literal text to type in the task itself. Personal values you write in the task are
sealed too (the model sees `⟪PHONE#1⟫`, the extension types the real value).

If a card asks **Allow once / Deny** (clicking by coordinates, risky submits, filling a critical
value), decide. **Stop** ends the task at any time.

## 7. What to watch

**Panel (top to bottom)**

| Indicator | Meaning |
|---|---|
| State: Loading → Running → **Done** / Error / Blocked | Loading = local models starting (a few s) |
| `vision: wasm/webgpu` | Local models loaded for this task (`idle` between tasks: they unload) |
| **Setup** (dropdown) | In order: task and site, content script connected, gateway session opened (live/record/replay), which local models loaded on which backend, task started |
| **Step N (s-N)** (dropdown; the latest one is open) | One per step, in execution order, each part itself a dropdown: **1. On this device** (perception summary + the run order: 1 DOM read, fields sensitive by label → placeholder · 2 Screenshot, crops chosen/reused/left grey · 3 YuNet faces · 4 PP-OCR text in pictures · 5 CLIP per picture, `looks like "…" → ENTITY score ✓ redacted` / `below threshold` · 6 whole-screen CLIP label · 7 text recognisers + merge, `redacted: EMAIL ⟪EMAIL#2⟫ ← field label + email pattern` · 8 compositor coverage · 9 guard passed / BLOCKED) · **2. Sent to the server** (task and title as sent, element/text counts, placeholders, screenshot size; **Show exact bytes sent**) · **3. Server reply (Groq VLM)** (rate-limit waits, the validated operations, and every text the model wrote in a box: report, done summary, stop explanation, question) · **4. Executed on this page** (`✓ executed` / `✗ failed: <reason>` / `✗ declined` / `– not run`, confirmations, navigations) · a timings line. Red lines = what became a redaction |
| **Result** | `Done: <summary>` or `Stopped: <reason>`, plus the model's last report or question |
| **Redactions (latest step)** | Types redacted locally; fields protected by their label (even when empty); `cleared` / `redacted` / `unanalysed` share of the screenshot; un-redact controls |
| Error line | Machine-readable reason, see section 9 |

**Gateway terminal**: one JSON line per event, no page text, no typed text, no key:
`model_usage prompt_tokens=…`, `step_processed … ops=["type","click","done"] plan=[{"op":"type","node":"n-…","ref":"⟪USERNAME#2⟫"},…]`,
`plan_retry errors=[{"loc":…,"type":…}]`, `model_error reason=upstream_429 retry_after_s=…`,
`unsanitized_context entities=[…]`, `model_request model=… response_format=… text_chars=…
images=[{"format":"image/webp","bytes":…}]` (sizes only), `model_error reason=upstream_too_large
status=413 type=tokens limit=7000 requested=…`, `prompt_refit limit=… requested=… fit=…`. Groq's full error body (its message and the rejected
output, org ids and base64 removed) is logged as `model_error_detail` only when the gateway is
started with `AEGIS_LOG_PAYLOADS=true` (dev only: it contains page-derived text).

**Panel console** (right-click the panel → Inspect → Console): `[aegis] step timings s-1
{"observe":1,"perceive":673,"sanitize":127,"guard":457,"server":1210,"validate":1,"act":22}` and
`[aegis] perception timings …` (ms, numbers only), `page navigated; reconnected`, capture failures.

## 8. Was the screenshot sanitized? Were the actions executed?

1. **Show exact bytes sent** → click the image to enlarge. This is the only image the server got.
   - Black boxes labelled `⟪EMAIL#1⟫` …: redacted values; `FACE` / `ID_DOCUMENT` / `SIGNATURE`:
     image regions the local vision models flagged.
   - Password/OTP/card fields: solid black (their values are never even read).
   - A field whose LABEL marks it sensitive (Full Name, Email ID, Login ID, …) is always black:
     `⟪EMAIL#2⟫` when it holds a value (sealed), `EMAIL field` when empty. Its pixels are never
     copied, whatever the DOM said its value was.
   - **Grey** = not analysed locally, so never sent as pixels (fails closed).
2. In the JSON next to it, values appear only as placeholders; search it for anything you know is
   on the page (your email, phone) — it must not be there.
3. Network proof: right-click the panel → Inspect → **Network** → the `…/steps` request →
   Payload is exactly what crossed the network; Response is the validated plan.
4. The gateway refuses (`UNSANITIZED_CONTEXT`) any step that still carries a raw Aadhaar, PAN,
   card, email or mobile number, and never forwards it to the model.
5. Execution: every Activity line turns `✓ executed` only after the content script reports the
   action done on the page; then look at the page itself.

## 9. Diagnosing a failure

| Panel message | Meaning / fix |
|---|---|
| `UNSUPPORTED_PAGE` | `chrome://`, Web Store, PDF viewer, `file://`: extensions can't run there |
| `PAGE_NOT_CONNECTED` | Content script not reachable: reload the page, Run again |
| `GATEWAY_UNREACHABLE` | Gateway not running / wrong Server URL |
| `GATEWAY_REJECTED_TOKEN (401)` | Settings token ≠ gateway `AEGIS_TOKEN` (`dev-token`) |
| Activity `model busy (… upstream_429 …): re-sending in N s` | Groq per-minute limit (8K tokens ≈ 1-2 steps/min); waits up to 65 s by itself |
| `SERVER_ERROR: MODEL_UNAVAILABLE upstream_429 retry in N s` | `N` > 65: Groq daily limit (200K tokens ≈ 35-40 steps); wait `N` s |
| Activity `model busy (… upstream_5xx …)` | Groq server trouble or dropped connection: re-sent once by itself |
| `SERVER_ERROR: MODEL_UNAVAILABLE upstream_too_large (input N tokens > limit 7000 per minute)` | The page is too dense for the key's per-request token limit even after the gateway shrank the element list (it does that by itself: `prompt_refit` in the gateway log). Scroll to a less dense part, or a narrower window. Not re-sent |
| `SERVER_ERROR: MODEL_UNAVAILABLE upstream_auth (401 invalid_api_key)` | Key invalid/revoked (`readyz` says not ready). Not re-sent |
| `SERVER_ERROR: MODEL_UNAVAILABLE upstream_4xx (<status> <code>)` | Groq refused the request itself (e.g. `404 model_not_found`, `400 context_length_exceeded`); the code says why. Not re-sent |
| `SERVER_ERROR: PLAN_INVALID` after gateway log `model_error reason=output_not_json code=json_validate_failed` | Groq ran the model and its answer was not JSON (the model started in prose). The gateway already gave it one corrective retry. Rare since the prompt routes questions to `report` and temperature is 0; run again |
| `SERVER_ERROR: MODEL_TIMEOUT` / `CLIENT_TIMEOUT` | Groq too slow this time; run again |
| `SERVER_ERROR: PLAN_INVALID` | The model answered with an invalid/unsafe plan twice; rephrase the task |
| Activity `plan rejected by the extension's validator` | The extension's own check refused the gateway's plan; nothing ran |
| `SERVER_ERROR: UNSANITIZED_CONTEXT <ENTITY>` | Server tripwire: the client missed a raw value; nothing reached the model |
| `Blocked — PATTERN / VAULT_LEAK` | The local guard refused to send the step (would have leaked) |
| `MODEL_STOPPED: <reason> (<model's explanation>)` | The model decided it cannot do it here; the explanation says why (e.g. no value given) |
| `NEEDS_USER` | The model asked you something (shown below); answer by rephrasing the task |
| Activity `✗ failed: FAILED_…` then `BUDGET_EXHAUSTED` | Actions kept failing (element hidden, covered, or gone) |
| `PAGE_DISCONNECTED: NEW_PAGE_UNREACHABLE` | An action opened a page AEGIS can't attach to (non-http, other tab) |
| `CAPTCHA_DETECTED` / `HOSTILE_DYNAMIC` | Stopped on purpose: CAPTCHA, or a page that never stops changing (no safe screenshot) |
| `VISION_UNAVAILABLE: no screenshot this step: …` | Vision is required on every step; the screenshot could not be taken or analysed (after 3 tries), so the step was not sent. `capture permission`: click the AEGIS icon on the tab |
| `VISION_UNAVAILABLE: the redacted screenshot failed the privacy re-scan…` | The guard still saw a face or sensitive text in the redacted screenshot; it was not sent, and neither was the step |
| `VISION_UNAVAILABLE - the local vision models failed to start` | The perception worker could not start; the task does not run without vision |
| `USER_DECLINED` | You pressed Deny |
| "Perception problem: …" | One local model failed to load: steps continue with the screenshot, and what that model would have analysed stays grey |

## 10. Known limits

- Groq free tier: ~4-6.7K input tokens per step; the current key's org allows **7K input
  tokens/minute** (checked 2026-09-29), 200K/day. Consecutive steps usually wait ~30-50 s for the
  per-minute window (shown in Activity). One request over 7K (a dense page such as a Gmail inbox:
  100 long rows) gets HTTP 413; the gateway then rebuilds that step with fewer elements/text lines
  (a 413 costs no quota) and gives up after two rebuilds.
- Model coordinates (`click_point`) are 0-1000 along the screenshot's long side
  (`AEGIS_MODEL_POINT_FORMAT=rel1000_long_side`); the gateway converts them to CSS pixels. Checked
  at 1280×800, 1920×1080 (image downscaled 0.667), 600×1000 portrait, 390×844 @2x and zoom 1.5.
- Person names in free prose are redacted only when a label names them ("Name: …", a "Full Name"
  field) or the task says them; the NER model is off by default.
- Pictures drawn as CSS backgrounds are analysed like `<img>` only when the element has no
  children/text; a background photo behind other content stays unanalysed (grey unless cleared
  by text on top). The guard's full-frame face re-check withholds the image if a face slips by.
- Local CLIP flags decorative art conservatively (Passport Seva's emblem and passport picture are
  redacted as ID_DOCUMENT; its CAPTCHA sometimes as SIGNATURE). Over-redaction, never a leak.
- New tabs/popups opened by a click are not followed; same-tab navigation is.
- Chrome only (Firefox build untested).

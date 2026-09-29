# AEGIS end-to-end demo (PS 26171)

One task on one synthetic page, through the whole architecture:

```
demo page -> extension: DOM graph + on-device vision (YuNet face, CLIP ViT, PP-OCR)
          -> local PII detection (patterns + field/label semantics + vision)
          -> local redaction (typed placeholders in the text, black boxes in the image)
          -> guard (schema, vault-leak sweep, pattern re-sweep, image re-scan)
          -> gateway (auth, session, UNSANITIZED_CONTEXT tripwire) -> VLM (Groq qwen/qwen3.8-27b)
          -> gateway validates/normalizes the plan -> extension executes it on the page
```

## 1. Start the gateway (terminal 1)

The Groq key goes in `server/deploy/model.env` (gitignored, `chmod 600`) as
`AEGIS_MODEL_API_KEY=...`; see `server/deploy/model.env.example`. Never paste it anywhere else.

```bash
cd AEGIS
server/deploy/run-gateway.sh          # http://127.0.0.1:8787, AEGIS_MODE=live
curl -s http://127.0.0.1:8787/readyz  # {"status":"ok"} = Groq reachable AND the key is accepted
```

## 2. Serve the demo page (terminal 2)

```bash
cd AEGIS
python3 -m http.server 8080 --bind 127.0.0.1 --directory demo
```

Open **http://127.0.0.1:8080/signin.html** (HTTP, not `file://`: Chrome cannot screenshot
`file://` pages for an extension).

## 3. Build and load the extension

```bash
cd AEGIS
pnpm install
pnpm --filter @aegis/extension run build:debug     # -> apps/extension/.output/chrome-mv3-dev
```

Chrome: `chrome://extensions` -> Developer mode on -> **Load unpacked** ->
`AEGIS/apps/extension/.output/chrome-mv3-dev`. Use the `-dev` build for the demo: it holds the
`<all_urls>` host permission, so screen capture works without a per-site prompt. (The release
build, `pnpm --filter @aegis/extension build`, needs a toolbar click per site to grant capture.)

The panel's gateway URL and token default to `http://localhost:8787` / `dev-token`
(Settings in the panel).

## 4. Run the task

1. With the demo tab in front, click the **AEGIS** toolbar icon: the side panel opens.
2. Task: **`Enter the username and click Sign in.`** -> **Run**.

What happens, stage by stage:

| Stage | Where | What you see |
|---|---|---|
| Local perception | perception worker | "Perception (s-1): DOM + face detection + vision/CLIP", YuNet finds the face |
| Local PII detection | host builder | "Redactions: PERSON_NAME, USERNAME, AADHAAR, PAN, PHONE, EMAIL, FACE, PASSWORD" |
| Local redaction | host + compositor | text carries `⟪USERNAME#2⟫` etc.; image has black labelled boxes (**Show exact bytes sent**) |
| Guard | host guard | passes; image re-scan finds no readable PII around the boxes |
| Gateway | server | log line `step_processed ... image=true ... ops=["type","click","done"]` |
| VLM | Groq | returns `type(node, ⟪USERNAME#2⟫)`, `click(Sign in)`, `done` in ~1-2 s |
| Execution | content script | the real username is filled in **locally** from the vault, Sign in is clicked |
| Result | page | green **"Signed in as rkumar_2291"**; panel says **Done** |

The VLM never sees the username, only `⟪USERNAME#2⟫`; the extension resolves it in the browser.

## 5. Automated run with a network-boundary privacy audit

Runs the same flow in a headless Chromium with the real extension, real gateway and real VLM, and
checks every byte sent to the gateway for the page's raw values:

```bash
cd AEGIS
eval/.venv/bin/python tools/e2e/run_demo.py            # add --headed to watch it
# exit 0 = task succeeded AND no raw value left the browser; artifacts in tools/e2e/out/
#   stepN-sent.json         exactly what the gateway received (image bytes elided)
#   stepN-sent-image.webp   the redacted image the VLM saw
#   stepN-received.json     the validated plan the extension executed
```

`tools/e2e/fake_vlm.py` is a scripted stand-in for the VLM, for debugging the extension and
gateway without spending quota. It is not the demo.

## Quota

Groq's free tier gives this model 200,000 tokens/day (a refilling bucket, ~139 tokens/min). One
demo step is ~4,700 prompt tokens, so budget roughly one run per 35 minutes if the bucket is
empty. A 429 shows in the panel as `MODEL_UNAVAILABLE upstream_429 retry in N s`.

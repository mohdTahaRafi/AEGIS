# tools/vlm

`smoke.py` is the R-1 probe for the server VLM ([R-1](../../../docs/planning/bugs/R-1-vlm-endpoint.md)).
It works against any OpenAI-compatible endpoint. The default is `qwen/qwen3.8-27b` on Groq's free
tier (`https://api.groq.com/openai/v1`), with thinking switched off by `reasoning_effort: "none"`.

```bash
set -a; . server/deploy/model.env; set +a     # or: export GROQ_API_KEY=gsk_...
python3 tools/vlm/smoke.py --runs 10 --trials 10 \
  --json-out tools/vlm/reports/r1-$(date +%F)-groq.json

# any other OpenAI-compatible endpoint (no Groq extra body is sent there)
python3 tools/vlm/smoke.py --base-url http://gpu-host:8000/v1 --model Qwen/Qwen3-VL-8B-Instruct
```

| Check | What it settles |
|---|---|
| `text` | A minimal authenticated call works. It always runs first, and the run stops if it fails |
| `vision` | The model reads pixels: a random code word exists only in the image. Exit code 1 if it fails |
| `grounding` | Raw point output for an unlabelled button, scored against three conventions: pixels, 0–1000 per axis, 0–1000 of the longer side (input for R-12) |
| `trials` | `--trials N` more vision + grounding calls, each on a freshly drawn image, reported as rates |
| `grounding_grid` | `--grounding-grid`: 4 unlabelled targets (colour + shape) on a landscape 1280×720 and a portrait 720×1280 canvas, one call each. Every point is scored under each convention, plus a per-axis linear fit (`a_x1000` = the image length the model's 0–1000 spans) (input for R-12) |
| `kwargs` | Which thinking switch is accepted and works: none, `chat_template_kwargs` (what the gateway sends), OpenRouter's `reasoning`, Groq's `reasoning_effort`. Judged from reasoning text returned, not just HTTP 200 (input for R-2/R-3) |
| `structured` | Whether `json_schema` / `json_object` are accepted and obeyed, and whether a schema is *enforced* (required keys the prompt never names) (input for R-3) |
| `gateway` | The gateway's exact request today (real action-plan schema, `strict: true`, `chat_template_kwargs`), then each part varied, so a rejection names its cause (input for R-2/R-3) |
| `latency` | TTFT and total time: real system prompt + ~1.2k-token step + one 1280×720 WebP, streamed, one warm-up then N runs |

`--image-format png` encodes the probe images as PNG instead of WebP (quality 80, what the
extension sends), to test whether compression explains a misread.

`--extra-body` is JSON merged into every request except the `kwargs` probe. It defaults to
`{"reasoning_effort": "none"}` for `api.groq.com` and `{}` elsewhere.

On HTTP 429 the script retries (`--max-retries`, default 6), waiting `--retry-wait` (default 15 s)
or the endpoint's `retry-after`, whichever is longer. It never waits more than 120 s: a longer
`retry-after` means a daily limit, and the call is recorded as failed instead. Each attempt is
timed on its own, and every 429 received is counted in the report (`retries_429` per call,
`rate_limited_429_total`). So throttling shows up as availability, never inside a latency figure.
A dropped connection or timeout is a failed sample with status 0; it never aborts the run. The
last `x-ratelimit-*` headers are kept in `rate_limit_headers_last`.

Everything sent is synthetic and drawn by the script. The key is read from `AEGIS_MODEL_API_KEY`,
`GROQ_API_KEY` or `OPENROUTER_API_KEY`, and never printed or written to the report. Latency is end
to end from this machine, network included, because provider hardware isn't disclosed.

Every call spends from Groq's free tier: 200,000 tokens per day **per organization**, shared by
every key and every teammate. A full `--runs 10 --trials 10` run is roughly 60–70 k tokens.

Reports (Groq free tier, `qwen/qwen3.8-27b`, all 2026-09-28 UTC):
- `reports/r1-2026-09-28-groq.json` — the R-1 decision run (`--runs 10 --trials 10`).
- `reports/r1-2026-09-28-groq-grounding-grid.json` — `--grounding-grid`, landscape and portrait.
- `reports/r1-2026-09-28-groq-vision-webp.json`, `…-vision-png.json` — `--trials 6` per format.
- `reports/r1-2026-09-28-groq-gateway-live.json` — the gateway live checks
  (`server/gateway/scripts/r2_live_check.py`, `r3_live_check.py`), written by hand from their
  output and the gateway's logs.
- `reports/r1-2026-09-28-hf-featherless.json` — superseded Hugging Face/Featherless run
  (Qwen3-VL-8B, 3/10 latency runs before credits ran out).

Needs Python ≥ 3.12 and Pillow. The system Python is enough; the gateway venv is not needed.

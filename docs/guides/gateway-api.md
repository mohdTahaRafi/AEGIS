# Legacy gateway API

`server/gateway` is a FastAPI server from the pre-release architecture. **A release build never
uses it.** It remains for the evaluation harness, the offline replay demo, and development builds
that have no API key saved. Request and response bodies are defined by the JSON Schemas in
`packages/protocol/schema/`; the Pydantic models in `aegis_gateway/protocol/` are generated from them.

**Base URL:** `http://127.0.0.1:8787` when started with `server/deploy/run-gateway.sh` (`AEGIS_PORT`
changes the port). The script runs in `live` mode against Groq and needs `AEGIS_MODEL_API_KEY` (or
`GROQ_API_KEY` in the repo's `.env`, or `server/deploy/model.env`).
**Auth:** `Authorization: Bearer <AEGIS_TOKEN>` on every `/v1` route (default token `dev-token`, for
local use only).

## Routes

| Method and path | Body | Success | Notes |
|---|---|---|---|
| `GET /healthz` | — | `200 {"status":"ok"}` | liveness, no auth |
| `GET /readyz` | — | `200` or `503` | replay mode: replay store loaded; otherwise the model API answers `GET /models` with the configured key |
| `POST /v1/sessions` | `SessionCreate` (`session.schema.json`): client capabilities only, no page data | `201 SessionCreated`: `session_id`, `model`, `mode`, `limits` | |
| `POST /v1/sessions/{id}/steps` | `SanitizedContext` (`sanitized-context.schema.json`) | `200 ActionPlan` (`action-plan.schema.json`) | rate limit: 5 steps per second per session |
| `DELETE /v1/sessions/{id}` | — | `204` | |

Each step is schema-validated, checked for order, scanned server-side for unsanitized values, turned
into a prompt, sent to the model (or looked up in the replay store), and the plan is validated before
it is returned.

## Errors

Every error has the body `{"error": {"code", "message", "request_id", "retryable"}}` and an
`X-Request-Id` header (`error.schema.json`).

| Status | Code | Retryable |
|---|---|---|
| 400 | `SCHEMA_INVALID` | no |
| 401 | `UNAUTHORIZED` | no |
| 404 | `SESSION_NOT_FOUND` | no |
| 409 | `STEP_OUT_OF_ORDER` | no |
| 413 | `PAYLOAD_TOO_LARGE` (`AEGIS_MAX_BODY_MB`, default 4) | yes |
| 422 | `UNSANITIZED_CONTEXT`, `PLAN_INVALID` | no |
| 429 | `RATE_LIMITED` | yes |
| 502 / 503 | `MODEL_UNAVAILABLE` | 503 yes, 502 no |
| 504 | `MODEL_TIMEOUT` | yes |

The source of truth is `aegis_gateway/errors.py`.

## Modes

`AEGIS_MODE` selects `live` (call the model), `record` (call it and store each plan), or `replay`
(answer from the store only, no model needed; the default). The full list of settings, with
defaults, is `load_settings()` in `aegis_gateway/config.py`.

## Example

```bash
TOKEN=dev-token
SESSION=$(curl -s -X POST http://127.0.0.1:8787/v1/sessions \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d @packages/protocol/test/contract/samples/valid/session-create.json | jq -r .session_id)

curl -s -X POST "http://127.0.0.1:8787/v1/sessions/$SESSION/steps" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d @packages/protocol/test/contract/samples/valid/sanitized-context.json
```

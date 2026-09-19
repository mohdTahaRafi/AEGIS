# Gateway API Reference

The AEGIS Gateway is a FastAPI server that receives sanitized screen contexts from the browser extension and returns constrained action plans. It enforces request validation, manages sessions with TTL, and supports record/replay for offline operation.

**Base URL:** `http://127.0.0.1:8000` (dev mode)  
**Auth:** Bearer token in `Authorization` header  
**Port:** Configurable via `AEGIS_GATEWAY_PORT` (default 8000)  

## Authentication

All endpoints except `/healthz` and `/readyz` require:

```
Authorization: Bearer <token>
```

Tokens are validated against `AEGIS_TOKEN` environment variable. Invalid tokens return `403 Forbidden`.

## Endpoints

### GET `/healthz`
Health check.

**Response:** `200 OK`
```json
{ "status": "ok" }
```

### GET `/readyz`
Readiness check (includes database/model dependencies).

**Response:** `200 OK` or `503 Service Unavailable`
```json
{ "status": "ready" }
```

### POST `/sessions`
Create a new agent session.

**Request:**
```json
{
  "task": "log in and submit the form",
  "page_category": "government",
  "page_title": "Citizen Portal",
  "viewport": { "w": 1280, "h": 720, "dpr": 1 }
}
```

**Response:** `201 Created`
```json
{
  "session_id": "sess-abc123...",
  "created_at": "2026-09-19T15:30:00Z"
}
```

**Errors:**
- `400 Bad Request` — missing/invalid fields
- `422 Unprocessable Entity` — validation failed (task must be non-empty, viewport dimensions > 0)

### GET `/sessions/{session_id}`
Get session state.

**Response:** `200 OK`
```json
{
  "session_id": "sess-abc123...",
  "task": "log in and submit the form",
  "state": "running",
  "step_count": 3,
  "created_at": "2026-09-19T15:30:00Z",
  "last_activity": "2026-09-19T15:30:45Z"
}
```

**Errors:**
- `404 Not Found` — session expired or does not exist

### POST `/sessions/{session_id}/steps`
Submit a sanitized context step and get back an action plan.

**Request:**
```json
{
  "step_id": "s-1",
  "reason": "initial",
  "sanitized_context": {
    "nodes": [ /* WireScreenNode[] */ ],
    "text": [ /* TextLine[] */ ],
    "redactions": [ /* Redaction[] */ ],
    "image": { "data": "base64...", "legend": "..." }
  }
}
```

**Response:** `200 OK`
```json
{
  "step_id": "s-1",
  "plan": {
    "actions": [
      { "op": "type", "node": "n-1", "text": "⟪AADHAAR#2⟫" },
      { "op": "click", "node": "n-2" },
      { "op": "wait", "ms": 500 }
    ]
  }
}
```

**Errors:**
- `400 Bad Request` — malformed context
- `404 Not Found` — session not found or expired
- `422 Unprocessable Entity` — context does not match schema
- `500 Internal Server Error` — model inference failed

### DELETE `/sessions/{session_id}`
End a session (cleanup).

**Response:** `204 No Content`

## Request/Response Schema

Full schemas are in `packages/protocol/schema/`. Key types:

**SanitizedContext:**
- `nodes: WireScreenNode[]` — screen elements with role, name, geometry, affordances
- `text: TextLine[]` — extracted text runs with bounding boxes
- `redactions: Redaction[]` — what was redacted and why (entity, confidence, channel)
- `image?: { data: string; legend: string }` — base64-encoded webp + legend text
- `coverage: { cleared_pct, redacted_pct }` — pixel coverage stats

**ActionPlan:**
- `actions: Action[]` where Action is one of:
  - `{ op: "type", node: string, text: string }` — fill a field
  - `{ op: "click", node: string }` — activate an element
  - `{ op: "wait", ms: number }` — delay before next action
  - `{ op: "done", summary?: string }` — task complete
  - `{ op: "report", title?: string, content: string }` — show user message

## Error Handling

All 4xx/5xx responses include:

```json
{
  "detail": "Human-readable error message",
  "error_type": "VALIDATION_ERROR|AUTH_ERROR|SERVER_ERROR",
  "request_id": "req-abc123..." /* for log correlation */
}
```

Common status codes:
- `200` — success
- `201` — created
- `204` — success, no content
- `400` — client error (bad request body)
- `403` — unauthorized (invalid token)
- `404` — not found (session expired)
- `422` — unprocessable (schema validation failed)
- `500` — server error (model inference timeout, etc.)

## Session Lifecycle

```
POST /sessions
  ↓
GET /sessions/{id}  [state: "running"]
  ↓
POST /sessions/{id}/steps  [step 1]
  ↓
POST /sessions/{id}/steps  [step 2]
  ↓
... [steps 3..N]
  ↓
POST /sessions/{id}/steps  [action: op=done]
  ↓
GET /sessions/{id}  [state: "completed"]
  ↓
DELETE /sessions/{id}  [cleanup]
```

Sessions auto-expire after 1 hour of inactivity (configurable via `AEGIS_SESSION_TTL_S`).

## Record/Replay Mode

Set `AEGIS_MODE=replay` to run in offline mode (no model server needed).

```bash
AEGIS_MODE=replay AEGIS_RECORD_DIR=/path/to/recorded/steps uv run uvicorn aegis_gateway.main:app
```

Recorded steps are stored as JSON files named by their canonical request hash:
```
record_dir/
  a1b2c3d4e5f6...json  # step 1, recorded response
  f6e5d4c3b2a1...json  # step 2, recorded response
```

## Rate Limiting

No explicit rate limiting, but:
- Max request body: 10 MB (configurable via `AEGIS_MAX_BODY_MB`)
- Session TTL: 3600 seconds (configurable)
- Per-session step limit: none (but steps have timeout)

## Example Usage

```bash
TOKEN="dev-token"
BASE="http://127.0.0.1:8000"

# Start session
SESSION=$(curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "task": "log in",
    "page_category": "government",
    "page_title": "Portal",
    "viewport": {"w": 1280, "h": 720, "dpr": 1}
  }' \
  $BASE/sessions | jq -r .session_id)

# Send a step
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "step_id": "s-1",
    "reason": "initial",
    "sanitized_context": {
      "nodes": [],
      "text": [],
      "redactions": [],
      "coverage": {"cleared_pct": 0.5, "redacted_pct": 0.5}
    }
  }' \
  $BASE/sessions/$SESSION/steps | jq .

# Check state
curl -s \
  -H "Authorization: Bearer $TOKEN" \
  $BASE/sessions/$SESSION | jq .

# End session
curl -s -X DELETE \
  -H "Authorization: Bearer $TOKEN" \
  $BASE/sessions/$SESSION
```

## Logging

Structured logs (JSON) are emitted to stdout. Set `AEGIS_LOG_LEVEL=debug` for verbose output.

Key fields:
- `request_id` — unique per request, for tracing
- `session_id` — which session
- `step_id` — which step
- `status_code` — HTTP status
- `duration_ms` — request latency
- `error` — error message if applicable

## Monitoring

Healthchecks are suitable for Kubernetes/Docker liveness/readiness probes:
- **Liveness:** `GET /healthz` (always returns 200)
- **Readiness:** `GET /readyz` (returns 200 only if dependencies are available)

## See Also

- [design.md §12](docs/design.md) — gateway architecture
- [architecture.md §8.2](docs/architecture.md) — server topology
- [phase_2_spine.md §6](docs/planning/phase_2_spine.md) — implementation notes

# server/deploy

Docker Compose deployment (architecture.md §13.2). **Scaffold — built in Phase 2 (T-2.43/T-2.44)
and completed in Phase 5 (offline path, T-5.11).**

Planned files:
- `docker-compose.yml` — Caddy (TLS) + gateway (FastAPI/Uvicorn) + vLLM, gateway and vLLM on a
  private network.
- `docker-compose.replay.yml` — gateway only, serving recorded responses, no GPU needed.
- `Caddyfile`, `gateway.Dockerfile`, `vllm.env`.
- `offline/` — scripts to pre-download weights, `docker save` images, enable HF offline mode, and
  generate an internal TLS certificate, so the same compose file runs air-gapped (FR-46, NFR-13).

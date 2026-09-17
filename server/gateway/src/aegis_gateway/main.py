"""FastAPI app factory. Scaffold — see architecture.md §8.2, design.md §12, docs/TASKS.md T-2.31/T-2.32."""

from fastapi import FastAPI


def create_app() -> FastAPI:
    app = FastAPI(title="AEGIS Agent Gateway", version="0.1.0")

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()

"""Shared helpers for the live checks: talk to a running gateway over HTTP. Standard library only.
Everything posted is synthetic. Errors are reported by status and the gateway's closed-vocabulary
error code/message, never by dumping a response body."""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request

BASE = os.environ.get("AEGIS_GATEWAY_URL", "http://127.0.0.1:8787")
TOKEN = os.environ.get("AEGIS_TOKEN", "dev-token")
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}


def post(path: str, body: dict, timeout: float = 120) -> tuple[int, dict, dict, float]:
    """Returns (status, parsed JSON body, response headers, seconds)."""
    req = urllib.request.Request(
        BASE + path, data=json.dumps(body).encode(), headers=HEADERS, method="POST"
    )
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return (
                resp.status,
                json.loads(resp.read()),
                dict(resp.headers),
                time.perf_counter() - t0,
            )
    except urllib.error.HTTPError as exc:
        try:
            parsed = json.loads(exc.read())
        except ValueError:
            parsed = {}
        return exc.code, parsed, dict(exc.headers), time.perf_counter() - t0


def open_session() -> str:
    status, body, _, _ = post(
        "/v1/sessions",
        {
            "schema": "AEGIS/1",
            "client": {
                "browser": "chrome",
                "extension_version": "0.1.0",
                "backend": "wasm",
                "detectors": {},
                "policy": "live-check",
                "capabilities": {"l1_image": True, "l2_crop": False, "click_point": True},
            },
        },
    )
    if status != 201:
        raise SystemExit(f"session open failed: HTTP {status} {describe_error(body)}")
    return body["session_id"]


def describe_error(body: dict) -> str:
    error = body.get("error") if isinstance(body, dict) else None
    if not isinstance(error, dict):
        return ""
    return f"{error.get('code')} ({error.get('message', '')[:120]})"


def step_body(**overrides: object) -> dict:
    body = {
        "schema": "AEGIS/1",
        "step_id": "s-1",
        "reason": "initial",
        "delta_of": None,
        "viewport": {"w": 1280, "h": 720, "dpr": 1, "scroll_y": 0, "doc_h": 720},
        "page": {"category": "unknown", "title": "Citizen Services Portal"},
        "text": [],
        "redactions": [],
        "unexplained": [],
        "coverage": {"cleared": 1, "redacted": 0, "unanalysed": 0},
        "image": None,
        "history": [],
        "client_timing": {},
    }
    body.update(overrides)
    return body


def post_step(body: dict, max_wait_s: float) -> tuple[int, dict, dict, float, list[float]]:
    """POST a step in a new session. On `503 MODEL_UNAVAILABLE upstream_429` with a `Retry-After`,
    sleep exactly that long (+2 s) and send the same step again, in another new session (the
    gateway has already consumed the step id: a resend in the same session is 409
    STEP_OUT_OF_ORDER), while the total wait stays within `max_wait_s`. Never earlier than Groq
    asked, so a wait costs no tokens. Returns the final result and the list of waits, so a report
    can show how much of a run was spent throttled."""
    waits: list[float] = []
    while True:
        session_id = open_session()
        status, parsed, headers, secs = post(f"/v1/sessions/{session_id}/steps", body)
        error = parsed.get("error") if isinstance(parsed, dict) else None
        retry_after = headers.get("Retry-After") or headers.get("retry-after")
        throttled = (
            status == 503
            and isinstance(error, dict)
            and str(error.get("message", "")).endswith("upstream_429")
            and retry_after is not None
        )
        if not throttled or sum(waits) + float(retry_after) + 2 > max_wait_s:
            return status, parsed, headers, secs, waits
        waits.append(float(retry_after) + 2)
        print(f"    429: waiting {waits[-1]:.0f} s as Groq asked", flush=True)
        time.sleep(waits[-1])


def pct(values: list[float], p: float) -> float:
    ordered = sorted(values)
    return ordered[max(0, min(len(ordered) - 1, round(p / 100 * len(ordered) + 0.5) - 1))]

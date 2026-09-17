"""design.md §4.1 (T-2.31 AC): missing token -> 401; 5 MB body -> 413; every response echoes
X-Request-Id."""

from __future__ import annotations

from fastapi.testclient import TestClient

from .conftest import sanitized_context_body, session_create_body


def test_missing_token_is_401(client: TestClient) -> None:
    res = client.post("/v1/sessions", json=session_create_body())
    assert res.status_code == 401
    assert res.json()["error"]["code"] == "UNAUTHORIZED"


def test_wrong_token_is_401(client: TestClient) -> None:
    res = client.post(
        "/v1/sessions", json=session_create_body(), headers={"Authorization": "Bearer wrong"}
    )
    assert res.status_code == 401


def test_correct_token_is_accepted(client: TestClient, auth_headers: dict) -> None:
    res = client.post("/v1/sessions", json=session_create_body(), headers=auth_headers)
    assert res.status_code == 201


def test_5mb_body_is_413(client: TestClient, auth_headers: dict) -> None:
    huge_task = "x" * (5 * 1024 * 1024)
    body = sanitized_context_body(task=huge_task)
    res = client.post(
        "/v1/sessions/does-not-matter/steps",
        json=body,
        headers={**auth_headers, "Content-Length": str(5 * 1024 * 1024 + 1000)},
    )
    assert res.status_code == 413
    assert res.json()["error"]["code"] == "PAYLOAD_TOO_LARGE"


def test_every_response_echoes_x_request_id(client: TestClient) -> None:
    res = client.get("/healthz", headers={"X-Request-Id": "my-request-id"})
    assert res.headers["X-Request-Id"] == "my-request-id"


def test_a_request_id_is_generated_when_the_client_sends_none(client: TestClient) -> None:
    res = client.get("/healthz")
    assert res.headers.get("X-Request-Id")


def test_error_responses_also_carry_the_request_id(client: TestClient) -> None:
    res = client.post(
        "/v1/sessions", json=session_create_body(), headers={"X-Request-Id": "abc-123"}
    )
    assert res.status_code == 401
    assert res.headers["X-Request-Id"] == "abc-123"
    assert res.json()["error"]["request_id"] == "abc-123"

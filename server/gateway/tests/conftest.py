from __future__ import annotations

import copy

import pytest
from aegis_gateway.config import Settings
from aegis_gateway.main import create_app
from fastapi.testclient import TestClient

TEST_TOKEN = "test-token"  # noqa: S105 - test fixture, not a real secret


def make_settings(**overrides: object) -> Settings:
    defaults = dict(
        token=TEST_TOKEN,
        model_url="http://localhost:9999/v1",
        model_name="test-model",
        mode="replay",
        record_dir="/tmp/aegis-gateway-test-replay",
        session_ttl_s=900,
        max_body_mb=4,
        log_payloads=False,
        model_timeout_s=5.0,
    )
    defaults.update(overrides)
    return Settings(**defaults)  # type: ignore[arg-type]


@pytest.fixture
def settings() -> Settings:
    return make_settings()


@pytest.fixture
def app(settings: Settings):
    return create_app(settings)


@pytest.fixture
def client(app) -> TestClient:
    return TestClient(app)


@pytest.fixture
def auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {TEST_TOKEN}"}


def session_create_body() -> dict:
    return {
        "schema": "AEGIS/1",
        "client": {
            "browser": "chrome",
            "extension_version": "0.1.0",
            "backend": "wasm",
            "detectors": {},
            "policy": "phase2-none",
            "capabilities": {"l1_image": False, "l2_crop": False, "click_point": True},
        },
    }


def sanitized_context_body(**overrides: object) -> dict:
    body = {
        "schema": "AEGIS/1",
        "step_id": "s-1",
        "task": "log in and submit the form",
        "reason": "initial",
        "viewport": {"w": 1280, "h": 720, "dpr": 1.0, "scroll_y": 0, "doc_h": 720},
        "page": {"category": "unknown", "title": "Login"},
        "nodes": [
            {
                "id": "n-1",
                "role": "textbox",
                "name": "Username",
                "box": [10, 20, 200, 30],
                "frame": "f-0",
                "z": 0,
                "state": {
                    "focused": False,
                    "disabled": False,
                    "required": True,
                    "has_value": False,
                },
                "affordances": ["click", "type"],
                "value": {"kind": "empty"},
            },
            {
                "id": "n-2",
                "role": "button",
                "name": "Sign in",
                "box": [10, 60, 100, 30],
                "frame": "f-0",
                "z": 0,
                "state": {"disabled": False},
                "affordances": ["click"],
            },
        ],
        "text": [],
        "redactions": [],
        "unexplained": [],
        "coverage": {"cleared": 1, "redacted": 0, "unanalysed": 0},
        "image": None,
        "history": [],
        "client_timing": {},
    }
    body.update(overrides)
    return copy.deepcopy(body)


def action_plan_body(step_id: str = "s-1", **overrides: object) -> dict:
    body = {
        "step_id": step_id,
        "actions": [
            {"op": "click", "node": "n-2", "expect": {"role": "button", "name": "Sign in"}}
        ],
    }
    body.update(overrides)
    return body

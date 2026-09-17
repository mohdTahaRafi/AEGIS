"""design.md §12.2 (T-2.35 AC): system prompt byte-identical across requests (asserted by hashing
it over 10 calls); compact element format; history windowed to K=5."""

from __future__ import annotations

import hashlib

from aegis_gateway.prompt import SYSTEM_PROMPT, build_messages
from aegis_gateway.prompt.elements import render_element_line
from aegis_gateway.prompt.history import HISTORY_WINDOW, window_history

from .conftest import sanitized_context_body


def test_system_prompt_is_byte_identical_across_10_calls() -> None:
    step = sanitized_context_body()
    hashes = set()
    for _ in range(10):
        messages = build_messages(step)
        system_message = next(m["content"] for m in messages if m["role"] == "system")
        hashes.add(hashlib.sha256(system_message.encode()).hexdigest())
    assert len(hashes) == 1
    assert next(iter(hashes)) == hashlib.sha256(SYSTEM_PROMPT.encode()).hexdigest()


def test_compact_element_line_format() -> None:
    node = {
        "id": "n-7f",
        "role": "textbox",
        "name": "Aadhaar number",
        "box": [220, 418, 340, 40],
        "state": {"required": True, "has_value": False},
    }
    line = render_element_line(node)
    assert line == 'n-7f | textbox | "Aadhaar number" | [220,418,340,40] | required, empty'


def test_history_is_windowed_to_the_last_5_steps() -> None:
    history = [
        {"step_id": f"s-{i}", "actions": [{"op": "click"}], "outcome": "ok"} for i in range(8)
    ]
    windowed = window_history(history)
    assert len(windowed) == HISTORY_WINDOW
    assert windowed[0]["step_id"] == "s-3"
    assert windowed[-1]["step_id"] == "s-7"


def test_user_message_includes_task_elements_and_history() -> None:
    step = sanitized_context_body(
        history=[{"step_id": "s-0", "actions": [{"op": "scroll"}], "outcome": "ok"}]
    )
    messages = build_messages(step)
    user_message = next(m["content"] for m in messages if m["role"] == "user")
    assert "log in and submit the form" in user_message
    assert "n-1" in user_message
    assert "Sign in" in user_message
    assert "s-0" in user_message

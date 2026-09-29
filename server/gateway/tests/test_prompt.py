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
        "affordances": ["click", "type"],
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
    assert "Sign in" in user_message
    # Element ids go to the model as short aliases (prompt/aliases.py), mapped back on the way out.
    assert "e1 | " in user_message and "n-1" not in user_message
    assert "s-0" in user_message


def test_a_large_page_is_capped_with_interactive_visible_elements_first() -> None:
    from aegis_gateway.prompt.elements import render_elements

    viewport = {"w": 1000, "h": 800}

    def node(i: int, y: int, interactive: bool) -> dict:
        return {"id": f"n-{i}", "role": "button" if interactive else "generic", "name": f"e{i}", "box": [0, y, 10, 10], "affordances": ["click"] if interactive else [], "state": {}}

    nodes = [node(i, 100, False) for i in range(5)] + [node(5, 100, True), node(6, 5000, True), node(7, 5000, False)]
    rendered = render_elements(nodes, viewport, 3).splitlines()
    assert [line.split(" | ")[0] for line in rendered[:3]] == ["n-0", "n-1", "n-5"]  # page order kept
    assert rendered[-1] == "(5 more elements off-screen or not shown)"
    assert "n-7" not in "\n".join(rendered)  # off-screen and not interactive: never shown

"""design.md §12.2 — assembles the system + user messages for one step. The system message is
always the exact same string (system.SYSTEM_PROMPT); everything per-request lives in the user
message. A step's image (the extension sends one every step) always goes to the model, whichever
route takes the step: there is no text-only prompt."""

from __future__ import annotations

from .aliases import node_aliases
from .elements import _short, in_viewport, render_elements
from .history import render_history
from .legend import render_legend
from .system import SYSTEM_PROMPT

__all__ = ["SYSTEM_PROMPT", "build_messages", "build_user_message"]

# Sized for Groq's 8K tokens/minute per model, where the screenshot alone costs ~3.6K and the
# system prompt ~0.7K: ~1.5K tokens of page text keeps a step near 5.5K, so two steps fit in a
# minute. The screenshot shows the page; this list is what the model can address by id (anything
# visible but not listed can still be clicked with click_point). Dense pages that still exceed an
# org's input limit are rebuilt with `fit` < 1, which keeps that share of these caps.
MAX_ELEMENTS = 45
MAX_TEXT_RUNS = 10
MAX_RUN_CHARS = 120
MIN_ELEMENTS = 10


def _caps(fit: float) -> tuple[int, int]:
    return max(MIN_ELEMENTS, int(MAX_ELEMENTS * fit)), int(MAX_TEXT_RUNS * fit)


def _image_lines(step_request: dict) -> str:
    image = step_request["image"]
    region = image["region"]
    coverage = step_request["coverage"]
    return (
        f"\nIMAGE: level={image['level']} "
        f"region=[{region[0]:g},{region[1]:g},{region[2]:g},{region[3]:g}] "
        f"scale={image['scale']:g} "
        f"cleared={coverage['cleared']:.2f} redacted={coverage['redacted']:.2f} "
        f"unanalysed={coverage['unanalysed']:.2f}\n"
        f"LEGEND: {image['legend']}"
    )


def build_user_message(step_request: dict, *, with_image: bool = False, fit: float = 1.0) -> str:
    max_elements, max_text_runs = _caps(fit)
    viewport = step_request["viewport"]
    # A run that repeats an element's name adds tokens, not information; off-screen prose is left
    # out (the model can scroll), and the rest is capped for the per-minute token budget.
    nodes = step_request.get("nodes", [])
    names = {n["name"] for n in nodes}
    runs = [
        t
        for t in step_request.get("text", [])
        if t["text"].strip() and t["text"] not in names and in_viewport(t["box"], viewport)
    ]
    # No ids: no action targets a text run.
    text_runs = "\n".join(f'"{_short(t["text"], MAX_RUN_CHARS)}"' for t in runs[:max_text_runs])
    legend = render_legend(step_request.get("redactions", []), with_boxes=with_image)
    aliases = node_aliases(step_request)
    message = (
        f"TASK: {step_request['task']}\n"
        f"HISTORY: {render_history(step_request.get('history', []), aliases)}\n"
        f"VIEWPORT: {viewport['w']}x{viewport['h']}, scroll_y={viewport['scroll_y']}\n"
        f"REDACTIONS: {legend}\n"
        "ELEMENTS:\n"
        f"{render_elements(nodes, viewport, max_elements, aliases)}\n"
        f"TEXT: {text_runs or '(none)'}"
    )
    if with_image:
        message += _image_lines(step_request)
    return message


def build_messages(step_request: dict, *, fit: float = 1.0) -> list[dict[str, object]]:
    image = step_request.get("image")
    text = build_user_message(step_request, with_image=image is not None, fit=fit)
    user_content: str | list[dict[str, object]] = text
    if image is not None:
        user_content = [
            {"type": "text", "text": text},
            {
                "type": "image_url",
                "image_url": {"url": f"data:{image['format']};base64,{image['data']}"},
            },
        ]
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_content},
    ]

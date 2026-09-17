"""design.md §12.1/§6.4 (T-2.37) — per-model adapter: coordinate conversion and chat-template
flags (e.g. disabling "thinking" mode) differ between model families.

phase_2_spine.md §14's forward dependency: **the coordinate convention is unverified until
OQ-13 closes** (the GPU/model choice is blocked on hardware the team hasn't picked yet). This
file's `IdentityCoordinateAdapter` assumes the model already outputs CSS-pixel viewport
coordinates matching our own schema — the simplest possible assumption, not a verified one. Swap
in a real adapter (a `ModelAdapter` implementation) once a model is chosen and its actual
convention is measured against real output, not assumed.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


class ModelAdapter(Protocol):
    def chat_template_kwargs(self) -> dict:
        """Extra kwargs merged into the chat-completions request (e.g. `{"chat_template_kwargs":
        {"enable_thinking": False}}` for a Qwen3-style non-thinking mode)."""
        ...

    def convert_point(self, x: float, y: float, viewport_w: float, viewport_h: float) -> tuple[float, float]:
        """Model output coordinates -> CSS-pixel viewport coordinates."""
        ...


@dataclass(frozen=True)
class IdentityCoordinateAdapter:
    """[A] OQ-13: unverified default. Disables thinking mode where the flag is harmless to pass
    even for a model that doesn't have one (vLLM ignores unknown `chat_template_kwargs` keys for
    templates that don't define them)."""

    def chat_template_kwargs(self) -> dict:
        return {"chat_template_kwargs": {"enable_thinking": False}}

    def convert_point(self, x: float, y: float, viewport_w: float, viewport_h: float) -> tuple[float, float]:
        return (x, y)


DEFAULT_ADAPTER = IdentityCoordinateAdapter()

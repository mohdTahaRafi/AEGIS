"""R-2: the guarded image reaches the model as an OpenAI image content part, and a step without
one keeps the exact pre-R-2 text format."""

from __future__ import annotations

from aegis_gateway.prompt import build_messages, build_user_message

from .conftest import sanitized_context_body

IMAGE = {
    "level": "L1",
    "region": [0, 0, 1280, 720],
    "scale": 1,
    "format": "image/webp",
    "sha256": "0" * 64,
    "data": "UklGRg==",
    "legend": "Grey = unanalysed.",
}
REDACTION = {
    "ref": "⟪AADHAAR#1⟫",
    "entity": "AADHAAR",
    "class": "CRITICAL",
    "boxes": [[220, 418, 340, 40]],
    "method": "placeholder",
    "confidence": 1,
    "sources": ["dom:aadhaar"],
    "unverified": False,
}


def _user(messages):
    return next(m["content"] for m in messages if m["role"] == "user")


def test_no_image_keeps_the_text_format_byte_identical() -> None:
    step = sanitized_context_body(redactions=[REDACTION])
    golden = build_user_message(step)
    assert _user(build_messages(step)) == golden
    assert "IMAGE:" not in golden
    assert "[220,418,340,40]" not in golden


def test_an_image_always_becomes_two_content_parts() -> None:
    step = sanitized_context_body(
        image=IMAGE,
        redactions=[REDACTION],
        coverage={"cleared": 0.62, "redacted": 0.04, "unanalysed": 0.34},
    )
    content = _user(build_messages(step))
    assert isinstance(content, list) and len(content) == 2
    assert content[0]["type"] == "text"
    assert content[1] == {
        "type": "image_url",
        "image_url": {"url": "data:image/webp;base64,UklGRg=="},
    }
    text = content[0]["text"]
    assert text.endswith(
        "IMAGE: level=L1 region=[0,0,1280,720] scale=1 cleared=0.62 redacted=0.04 "
        "unanalysed=0.34\nLEGEND: Grey = unanalysed."
    )
    assert "⟪AADHAAR#1⟫ | AADHAAR | CRITICAL | [220,418,340,40]" in text

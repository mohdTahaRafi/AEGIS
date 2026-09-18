"""architecture §12.3 / design.md §18.2's leak-count metric: the auditor's OCR pass over captured
payload IMAGES, run with a server-grade model the client cannot afford (it doesn't have metric 4's
budget) — precisely to estimate what the client's cheap on-device detectors might have missed.

[A] DISCLOSED LIMITATION, same category as `apps/extension/src/perception/models/vit-encoder.ts`
and `host/privacy/ner-stub.ts`: no OCR model (this needs something like a full PP-OCRv5 stack, or
a hosted OCR API) is available in this sandboxed, network-restricted Python environment — no
`onnxruntime`/`torch`/OCR package is installed, and there is no network access to fetch one. This
defines the real call shape `recover.py`/the leak-count scorer expects; it always returns no text,
which the leak count treats as "not checked," never as "checked and clean" (the composed-image
leak-count row in the scoreboard must say so explicitly — see `report/scoreboard.py`).
"""

from __future__ import annotations


def ocr_image_text(_image_bytes: bytes) -> str:
    return ""

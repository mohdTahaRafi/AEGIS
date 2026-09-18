"""design.md §18.3 — the four ablation arms, as one closed list every other module in this
package imports from, so `fused`/`dom_only`/`pixel_only`/`blackbox` are never hand-typed (and
so never able to silently drift) in more than one place."""

from __future__ import annotations

ARMS: tuple[str, ...] = ("fused", "dom_only", "pixel_only", "blackbox")

ARM_CLAIMS: dict[str, str] = {
    "fused": "The default pipeline — the claim every other row is measured against.",
    "dom_only": (
        "DOM-only leaks on canvas/PDF/image pages (Channel V disabled, no image ever attached)."
    ),
    "pixel_only": (
        "Pixel-only is slower and type-blind; line-level boxes over-redact "
        "(Channel D/DOM text ignored, OCR runs over the whole frame)."
    ),
    "blackbox": (
        "Black-box redaction destroys the context the server needs "
        "(typed placeholders replaced with unlabelled black boxes, no refs sent)."
    ),
}

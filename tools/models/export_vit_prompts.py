"""Precompute the zero-shot ViT's text-prompt embeddings at build time (design.md §6.4,
phase_4_vision.md §4.2, T-4.5).

The text tower of a CLIP-family model is typically as large as the image tower and is never
needed at runtime once the prompt embeddings are fixed — this script runs the text encoder once,
offline, and writes only the resulting vectors, so the shipped extension needs the image encoder
only.

DISCLOSED, NOT SILENTLY ASSUMED: this script has not been run in the environment this phase was
built in. It has no network access to Hugging Face Hub and no CLIP-family checkpoint (open_clip,
transformers, torch) installed, so there is nothing to execute it against. It is written to the
real, intended interface — the same prompt vocabulary `apps/extension/src/perception/models/
vit-encoder.ts` defines and expects `vit-prompts.bin` to match label-for-label — so that running it
in a normal ML environment (`pip install torch open_clip_torch` + network access) produces the
real artifact with no code changes on either side.

Usage:
    python export_vit_prompts.py --model ViT-B-32 --pretrained openai --out ../../apps/extension/public/models/vit-prompts.bin
"""

from __future__ import annotations

import argparse
import struct
import sys

# Mirrors PROMPT_VOCABULARY in apps/extension/src/perception/models/vit-encoder.ts exactly —
# order matters, since the output file's vectors are positional, not labelled.
PROMPT_VOCABULARY = [
    "identity card",
    "Aadhaar card",
    "PAN card",
    "passport page",
    "credit or debit card",
    "handwritten signature",
    "QR code",
    "barcode",
    "photo of a person",
    "document page with text",
    "login form",
    "chart",
    "logo",
    "icon",
    "plain background",
]

MAGIC = b"AEGISVPB1"  # "AEGIS ViT Prompts, Bin, v1"


def build_prompt_text(label: str) -> str:
    """A plain, single-template prompt per label — design.md §6.4 does not specify prompt
    ensembling, and CLIP zero-shot with a single well-chosen template is a documented, defensible
    baseline (ensembling many templates is a real quality lever, but it is a tuning question for
    Phase 5's harness, not a Phase 4 build-script decision)."""
    return f"a photo of a {label}"


def export_prompts(model_name: str, pretrained: str, out_path: str) -> None:
    try:
        import open_clip  # type: ignore[import-not-found]
        import torch  # type: ignore[import-not-found]
    except ImportError as exc:  # pragma: no cover - environment-dependent, disclosed above
        print(
            f"[export_vit_prompts] missing dependency: {exc}. "
            "Install with: pip install torch open_clip_torch",
            file=sys.stderr,
        )
        raise SystemExit(1) from exc

    model, _, _ = open_clip.create_model_and_transforms(model_name, pretrained=pretrained)
    tokenizer = open_clip.get_tokenizer(model_name)
    model.eval()

    prompts = [build_prompt_text(label) for label in PROMPT_VOCABULARY]
    tokens = tokenizer(prompts)
    with torch.no_grad():
        embeddings = model.encode_text(tokens)
        embeddings = embeddings / embeddings.norm(dim=-1, keepdim=True)  # pre-normalized for cosine

    dim = embeddings.shape[1]
    with open(out_path, "wb") as f:
        f.write(MAGIC)
        f.write(struct.pack("<II", len(PROMPT_VOCABULARY), dim))
        for label in PROMPT_VOCABULARY:
            label_bytes = label.encode("utf-8")
            f.write(struct.pack("<H", len(label_bytes)))
            f.write(label_bytes)
        f.write(embeddings.numpy().astype("float32").tobytes())

    print(f"[export_vit_prompts] wrote {len(PROMPT_VOCABULARY)} prompt embeddings (dim={dim}) to {out_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="ViT-B-32", help="open_clip model architecture name")
    parser.add_argument("--pretrained", default="openai", help="open_clip pretrained tag")
    parser.add_argument("--out", default="../../apps/extension/public/models/vit-prompts.bin")
    args = parser.parse_args()
    export_prompts(args.model, args.pretrained, args.out)


if __name__ == "__main__":
    main()

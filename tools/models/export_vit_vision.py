"""Export the CLIP-family vision tower to ONNX (design.md §6.4, phase_4_vision.md §4.2, T-4.5/T-4.6).

Companion to `export_vit_prompts.py`, which precomputes the text-side prompt embeddings so the
text tower never ships. This script exports only the image encoder — the one component the
extension actually needs at runtime, per `apps/extension/src/perception/models/vit-encoder.ts`'s
documented call shape (`classifyRegion`/`screenLabel` embed a crop, then compare against the
precomputed prompt vectors via `classifyByCosine`).

The exported graph takes a preprocessed `[1, 3, 224, 224]` float32 tensor (already resized,
center-cropped and normalized with CLIP's mean/std — see this model's own `preprocess` transform,
which the browser side must replicate exactly) and outputs a single `[1, 512]` L2-normalized
embedding, so the browser never needs the text tower's tokenizer or the projection math beyond a
dot product.

Usage:
    python export_vit_vision.py --model ViT-B-32-quickgelu --pretrained openai \
        --out ../../apps/extension/public/models/vit-vision.onnx
"""

from __future__ import annotations

import argparse

import torch


class NormalizedVisualEncoder(torch.nn.Module):
    """Wraps `model.encode_image` so the exported graph's own output is already L2-normalized —
    matching `export_vit_prompts.py`'s prompt vectors, which are normalized the same way, so the
    browser-side `classifyByCosine` (already dividing by the norm defensively) gets unit vectors
    from both sides, exactly as design.md §6.4's cosine-similarity rule assumes."""

    def __init__(self, clip_model: torch.nn.Module) -> None:
        super().__init__()
        self.visual = clip_model.visual

    def forward(self, pixel_values: torch.Tensor) -> torch.Tensor:
        features = self.visual(pixel_values)
        return features / features.norm(dim=-1, keepdim=True)


def export_vision(model_name: str, pretrained: str, out_path: str, opset: int) -> None:
    import open_clip  # type: ignore[import-not-found]

    model, _, preprocess = open_clip.create_model_and_transforms(model_name, pretrained=pretrained)
    model.eval()

    image_size = model.visual.image_size
    if isinstance(image_size, int):
        h = w = image_size
    else:
        h, w = image_size
    print(f"[export_vit_vision] {model_name}/{pretrained} — input {h}x{w}, preprocess: {preprocess}")

    wrapped = NormalizedVisualEncoder(model)
    wrapped.eval()

    dummy = torch.randn(1, 3, h, w)
    with torch.no_grad():
        sanity = wrapped(dummy)
    dim = sanity.shape[-1]

    torch.onnx.export(
        wrapped,
        (dummy,),
        out_path,
        input_names=["pixel_values"],
        output_names=["image_embedding"],
        dynamo=False,
        opset_version=opset,
        do_constant_folding=True,
    )
    print(f"[export_vit_vision] wrote ONNX vision encoder (dim={dim}, opset={opset}) to {out_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="ViT-B-32-quickgelu", help="open_clip model architecture name")
    parser.add_argument("--pretrained", default="openai", help="open_clip pretrained tag")
    parser.add_argument("--out", default="../../apps/extension/public/models/vit-vision.onnx")
    parser.add_argument("--opset", type=int, default=17)
    args = parser.parse_args()
    export_vision(args.model, args.pretrained, args.out, args.opset)


if __name__ == "__main__":
    main()

"""Precompute the zero-shot ViT's text-prompt embeddings at build time (design.md §6.4,
phase_4_vision.md §4.2, T-4.5).

The text tower of a CLIP-family model is typically as large as the image tower and is never
needed at runtime once the prompt embeddings are fixed — this script runs the text encoder once,
offline, and writes only the resulting vectors, so the shipped extension needs the image encoder
only.

Run for real (2026-09-25 first export, 2026-09-28 prompt-ensemble retune) against open_clip's
`ViT-B-32-quickgelu`/`openai` weights; the output must stay label-for-label matched to
`PROMPT_VOCABULARY` in `apps/extension/src/perception/models/vit-encoder.ts`, and its sha256
mirrored in `models.manifest.json` and `entrypoints/sidepanel/main.tsx`.

Usage:
    python export_vit_prompts.py --model ViT-B-32-quickgelu --pretrained openai --out ../../apps/extension/public/models/vit-prompts.bin
"""

from __future__ import annotations

import argparse
import struct
import sys

# Mirrors PROMPT_VOCABULARY in apps/extension/src/perception/models/vit-encoder.ts exactly —
# order matters, since the output file's vectors are positional, not labelled. Each label maps to a
# small ensemble of prompt phrasings; the shipped vector is the L2-normalized mean of the ensemble's
# normalized text embeddings (Radford et al. 2021, §3.1.4 "prompt ensembling").
#
# 2026-09-28 retune (docs/HISTORY.md): the previous single template "a photo of a {label}" combined
# with the runtime's old softmax temperature (0.07) accepted 0/69 real sensitive images in a
# 168-image Wikimedia Commons evaluation (ID cards, passports, Aadhaar/PAN samples, bank cards,
# signatures, QR codes/barcodes vs. portraits, group photos, landscapes, food, maps, charts, logos,
# paintings, web screenshots). These ensembles (written before that evaluation was run, not
# iterated against it) + the last five "everything else" labels + CLIP's own trained temperature
# (0.01), with per-entity probability pooling, accepted 69/69 with 6/82 false positives on
# unrelated portraits/photos (13 more on Aadhaar-themed event photos and logos). The five extra
# labels exist only to absorb probability mass from ordinary photos that would otherwise be forced
# onto a sensitive label — they never map to an entity.
PROMPT_ENSEMBLES: dict[str, list[str]] = {
    "identity card": [
        "a photo of an identity card",
        "a national ID card with a photo of the card holder",
        "a government-issued photo identity card",
        "a driver's license",
        "a scan of an ID card showing name, date of birth and photo",
    ],
    "Aadhaar card": [
        "a photo of an Aadhaar card",
        "an Indian Aadhaar card with photo, QR code and 12-digit number",
        "an e-Aadhaar printout from UIDAI",
        "an Aadhaar identity card from India",
    ],
    "PAN card": [
        "a photo of a PAN card",
        "an Indian Income Tax Department PAN card",
        "a permanent account number card from India with photo and signature",
    ],
    "passport page": [
        "a photo of a passport data page",
        "the personal data page of a passport with a machine readable zone",
        "an open passport showing the photo and personal details of the holder",
        "a scanned passport page",
        "a visa in a passport",
    ],
    "credit or debit card": [
        "a photo of a credit card",
        "a debit card with a card number and chip",
        "a bank card",
        "a person holding a credit card",
    ],
    "handwritten signature": [
        "a handwritten signature",
        "a signature written in ink",
        "an autograph",
        "a scanned signature on paper",
    ],
    "QR code": ["a QR code", "a black and white QR code", "a photo of a QR code", "a QR code for payment"],
    "barcode": ["a barcode", "a black and white barcode with numbers", "a UPC product barcode", "a barcode on a label"],
    "photo of a person": ["a photo of a person", "a portrait of a person", "a photo of a group of people", "a painting of a person"],
    "document page with text": [
        "a page of printed text",
        "a scanned document",
        "a newspaper page",
        "a book page",
        "a handwritten letter",
    ],
    "login form": ["a website login form", "a screenshot of a sign in page", "a screenshot of a web form"],
    "chart": ["a chart", "a bar chart", "a graph of data", "a diagram"],
    "logo": ["a logo", "a company logo", "a brand logo"],
    "icon": ["an icon", "a small user interface icon", "an emoji"],
    "plain background": ["a plain background", "a blank empty area", "a solid color background"],
    "landscape or scene": [
        "a photo of a landscape",
        "a photo of a city",
        "a photo of a building",
        "a photo of nature",
        "a photo of the sky at night",
    ],
    "painting or illustration": ["a painting", "an illustration", "a drawing", "a religious icon painting"],
    "everyday object, food or animal": [
        "a photo of food",
        "a photo of an animal",
        "a photo of a car",
        "a photo of a flower",
        "a product photo",
    ],
    "map": ["a map", "an old map", "a satellite map"],
    "website screenshot": ["a screenshot of a website", "a screenshot of a web page", "a screenshot of an app"],
}
PROMPT_VOCABULARY = list(PROMPT_ENSEMBLES)

MAGIC = b"AEGISVPB1"  # "AEGIS ViT Prompts, Bin, v1"


def build_prompt_texts(label: str) -> list[str]:
    """The ensemble for one label — see PROMPT_ENSEMBLES' comment for why an ensemble, not the old
    single "a photo of a {label}" template."""
    return PROMPT_ENSEMBLES[label]


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

    vectors = []
    with torch.no_grad():
        for label in PROMPT_VOCABULARY:
            per_prompt = model.encode_text(tokenizer(build_prompt_texts(label)))
            per_prompt = per_prompt / per_prompt.norm(dim=-1, keepdim=True)
            mean = per_prompt.mean(dim=0)
            vectors.append(mean / mean.norm())  # pre-normalized for cosine
    embeddings = torch.stack(vectors)

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
    parser.add_argument("--model", default="ViT-B-32-quickgelu", help="open_clip model architecture name")
    parser.add_argument("--pretrained", default="openai", help="open_clip pretrained tag")
    parser.add_argument("--out", default="../../apps/extension/public/models/vit-prompts.bin")
    args = parser.parse_args()
    export_prompts(args.model, args.pretrained, args.out)


if __name__ == "__main__":
    main()

"""Produce int8/fp16 variants of the client-side ONNX models (architecture §6.3, phase_4_vision.md
§14). Architecture §6.3's warning applies here: do not int8 a model if it costs meaningful
accuracy, since accuracy is worth more evaluation points than a few saved megabytes — this script
produces candidate variants for the phase's bake-off (`docs/bakeoff_phase4.md`, not written by this
script) to compare against the size/accuracy budget, and does not itself decide which variant ships.

DISCLOSED, NOT SILENTLY ASSUMED: not run in the environment this phase was built in — no
`onnxruntime` Python package (with its quantization tooling) is installed here. Written to the
real intended interface so it runs unchanged once `onnxruntime` is available.

Usage:
    python quantize.py --input face_detection_yunet_2023mar.onnx --mode int8 --out face_int8.onnx
    python quantize.py --input face_detection_yunet_2023mar.onnx --mode fp16 --out face_fp16.onnx
"""

from __future__ import annotations

import argparse
import sys


def quantize_int8(input_path: str, out_path: str) -> None:
    try:
        from onnxruntime.quantization import QuantType, quantize_dynamic  # type: ignore[import-not-found]
    except ImportError as exc:  # pragma: no cover - environment-dependent, disclosed above
        print(f"[quantize] missing dependency: {exc}. Install with: pip install onnxruntime", file=sys.stderr)
        raise SystemExit(1) from exc

    quantize_dynamic(input_path, out_path, weight_type=QuantType.QInt8)
    print(f"[quantize] wrote int8 model to {out_path}")


def quantize_fp16(input_path: str, out_path: str) -> None:
    try:
        import onnx  # type: ignore[import-not-found]
        from onnxconverter_common import float16  # type: ignore[import-not-found]
    except ImportError as exc:  # pragma: no cover - environment-dependent, disclosed above
        print(
            f"[quantize] missing dependency: {exc}. Install with: pip install onnx onnxconverter-common",
            file=sys.stderr,
        )
        raise SystemExit(1) from exc

    model = onnx.load(input_path)
    model_fp16 = float16.convert_float_to_float16(model)
    onnx.save(model_fp16, out_path)
    print(f"[quantize] wrote fp16 model to {out_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="path to the source fp32 .onnx model")
    parser.add_argument("--mode", choices=["int8", "fp16"], required=True)
    parser.add_argument("--out", required=True, help="path to write the quantized .onnx model")
    args = parser.parse_args()

    if args.mode == "int8":
        quantize_int8(args.input, args.out)
    else:
        quantize_fp16(args.input, args.out)


if __name__ == "__main__":
    main()

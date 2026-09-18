"""design.md §18.3, T-6.10 — runs the `pixel_only` arm alone: Channel D and DOM text ignored,
OCR runs over the whole captured frame. See `runner/main.py`'s `run()` for the actual mechanics."""

from __future__ import annotations

import sys

from aegis_eval.runner.main import run


def main() -> int:
    split = sys.argv[1] if len(sys.argv) > 1 else "dev"
    return run(split, ablation_arm="pixel_only")


if __name__ == "__main__":
    sys.exit(main())

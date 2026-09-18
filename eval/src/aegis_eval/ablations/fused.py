"""design.md §18.3, T-6.10 — runs the `fused` arm alone (the default pipeline, driven through
the DEBUG build so it's directly comparable against the other three arms run the same way, per
`runner/main.py`'s `run()` docstring on why `'fused'` still means the debug build here)."""

from __future__ import annotations

import sys

from aegis_eval.runner.main import run


def main() -> int:
    split = sys.argv[1] if len(sys.argv) > 1 else "dev"
    return run(split, ablation_arm="fused")


if __name__ == "__main__":
    sys.exit(main())

"""R-2 live check: the model must pick a node only identifiable from the image.

Three buttons with empty names; only the pixels (smoke.py's fixture: a green button under a red
banner) say which is right. Run against a gateway in live mode:

    cd server/gateway
    set -a; . ../deploy/model.env; set +a
    AEGIS_MODE=live AEGIS_TOKEN=dev-token .venv/bin/uvicorn aegis_gateway.main:app --port 8787
    python3 scripts/r2_live_check.py --runs 3   # system Python: needs Pillow
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import sys
import time
from pathlib import Path

from _live import describe_error, post_step, step_body

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "tools" / "vlm"))
from smoke import BUTTON_BOX, make_fixture_image  # noqa: E402

TARGET = "n-b2"


def _node(node_id: str, box: list[int]) -> dict:
    return {
        "id": node_id,
        "role": "button",
        "name": "",
        "box": box,
        "frame": "f-0",
        "z": 0,
        "state": {},
        "affordances": ["click"],
    }


def run_once(max_wait: float) -> tuple[bool, str, list[float]]:
    webp = make_fixture_image("ZEBRA-42")
    x0, y0, x1, y1 = BUTTON_BOX
    body = step_body(
        task="Click the green button below the red banner.",
        nodes=[
            _node("n-a1", [260, 520, 200, 60]),
            _node(TARGET, [x0, y0, x1 - x0, y1 - y0]),
            _node("n-c3", [40, 640, 160, 50]),
        ],
        coverage={"cleared": 0.8, "redacted": 0.02, "unanalysed": 0.18},
        image={
            "level": "L1",
            "region": [0, 0, 1280, 720],
            "scale": 1,
            "format": "image/webp",
            "sha256": hashlib.sha256(webp).hexdigest(),
            "data": base64.b64encode(webp).decode(),
            "legend": "Grey = unanalysed. Black boxes are redacted.",
        },
    )
    status, plan, headers, secs, waits = post_step(body, max_wait)
    if status != 200:
        return False, f"HTTP {status} {describe_error(plan)} ({secs:.1f} s)", waits
    ok = any(a.get("op") == "click" and a.get("node") == TARGET for a in plan["actions"])
    timing = headers.get("Server-Timing", "")
    return ok, f"{json.dumps(plan['actions'])} ({secs:.1f} s; {timing})", waits


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--runs", type=int, default=1)
    ap.add_argument(
        "--max-wait",
        type=float,
        default=0,
        help="per run, how long to wait out Groq 429s (Retry-After) before counting a failure",
    )
    ap.add_argument(
        "--pause",
        type=float,
        default=20,
        help="seconds between runs, to stay under the free tier's 8K tokens/min",
    )
    args = ap.parse_args()
    passed = 0
    waits: list[float] = []
    for i in range(args.runs):
        if i:
            time.sleep(args.pause)
        ok, detail, run_waits = run_once(args.max_wait)
        waits += run_waits
        passed += ok
        print(f"run {i + 1}: {'PASS' if ok else 'FAIL'} {detail}")
    print(
        f"R-2 live check: {passed}/{args.runs} picked {TARGET}; "
        f"waited for 429s {len(waits)}x, {sum(waits):.0f} s in total"
    )
    return 0 if passed == args.runs else 1


if __name__ == "__main__":
    raise SystemExit(main())

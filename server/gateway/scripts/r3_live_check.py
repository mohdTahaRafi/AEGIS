"""R-3 live check: a text-only login step, in a new session each time. The answer must come back
as a valid plan (json_object output, normalized and validated by the gateway), with the bare ref
the model writes wrapped back to ⟪USERNAME#1⟫.

    python3 scripts/r3_live_check.py --runs 10
"""

from __future__ import annotations

import argparse
import json
import time
from collections import Counter

from _live import describe_error, pct, post_step, step_body

REF = "⟪USERNAME#1⟫"


def _body() -> dict:
    def node(node_id, role, name, box, affordances, value=None):
        n = {
            "id": node_id,
            "role": role,
            "name": name,
            "box": box,
            "frame": "f-0",
            "z": 0,
            "state": {},
            "affordances": affordances,
        }
        if value is not None:
            n["value"] = value
        return n

    return step_body(
        task="Type my username into the username field, then click Sign in.",
        page={"category": "unknown", "title": "Sign in"},
        nodes=[
            node(
                "n-u",
                "textbox",
                "Username",
                [400, 200, 320, 36],
                ["click", "type"],
                {"kind": "empty"},
            ),
            node(
                "n-p",
                "textbox",
                "Password",
                [400, 260, 320, 36],
                ["click", "type"],
                {"kind": "presence", "entity": "PASSWORD", "len": 12},
            ),
            node("n-s", "button", "Sign in", [400, 320, 120, 40], ["click"]),
        ],
        redactions=[
            {
                "ref": REF,
                "entity": "USERNAME",
                "class": "HIGH",
                "boxes": [],
                "method": "placeholder",
                "confidence": 1,
                "sources": ["user:vault"],
                "unverified": False,
            }
        ],
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--runs", type=int, default=10)
    ap.add_argument(
        "--max-wait",
        type=float,
        default=0,
        help="per run, how long to wait out Groq 429s (Retry-After) before counting a failure",
    )
    ap.add_argument(
        "--pause",
        type=float,
        default=15,
        help="seconds between runs, to stay under the free tier's 8K tokens/min",
    )
    args = ap.parse_args()
    outcomes: Counter[str] = Counter()
    seconds: list[float] = []
    expected = 0
    waits: list[float] = []
    for i in range(args.runs):
        if i:
            time.sleep(args.pause)
        status, plan, _, secs, run_waits = post_step(_body(), args.max_wait)
        waits += run_waits
        outcomes[str(status)] += 1
        if status == 200:
            seconds.append(secs)
            ops = [(a.get("op"), a.get("node"), a.get("ref")) for a in plan["actions"]]
            typed = ("type", "n-u", REF) in ops
            clicked = ("click", "n-s", None) in ops
            expected += typed and clicked
            print(
                f"run {i + 1}: 200 {secs:.1f} s typed_ref={typed} clicked={clicked} "
                f"{json.dumps(plan['actions'], ensure_ascii=False)}"
            )
        else:
            print(f"run {i + 1}: HTTP {status} {describe_error(plan)} ({secs:.1f} s)")
    ok = outcomes["200"]
    timing = f" p50={pct(seconds, 50):.2f}s p95={pct(seconds, 95):.2f}s" if seconds else ""
    print(
        f"ok={ok}/{args.runs}{timing} statuses={dict(outcomes)} as_expected={expected}/{ok} "
        f"waited_for_429={len(waits)}x/{sum(waits):.0f}s"
    )
    return 0 if ok == args.runs else 1


if __name__ == "__main__":
    raise SystemExit(main())

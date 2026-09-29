"""Drives the real end-to-end demo: real Chromium + the real unpacked AEGIS extension + the real
gateway + the real VLM, on demo/signin.html. Nothing is mocked. The gateway requests are only
observed (Playwright request events), never intercepted, so this also serves as the privacy audit
at the network boundary: every byte the extension sends to the gateway is checked for the page's
raw sensitive values.

Prerequisites (three terminals):
    server/deploy/run-gateway.sh                                      # gateway, :8787, live VLM
    python3 -m http.server 8080 --bind 127.0.0.1 --directory demo     # the demo page
    pnpm --filter @aegis/extension run build:debug                    # .output/chrome-mv3-dev

Run:
    eval/.venv/bin/python tools/e2e/run_demo.py [--headed] [--out DIR]

Exit code 0 only if the task succeeded on the page AND no raw sensitive value left the browser.
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parents[2]
EXTENSION_DIR = REPO / "apps" / "extension" / ".output" / "chrome-mv3-dev"
DEMO_URL = "http://127.0.0.1:8080/signin.html"
GATEWAY = "http://localhost:8787"
TASK = "Enter the username and click Sign in."
REGISTERED_USERNAME = "rkumar_2291"

# Raw values on the demo page that must never appear in anything sent to the gateway. Each is
# listed in the separator variants a leak could take.
SENSITIVE = {
    "AADHAAR": ["4987 1234 5679", "498712345679", "4987-1234-5679"],
    "PAN": ["ABCPK1234F"],
    "PHONE": ["98765 43210", "9876543210"],
    "EMAIL": ["ramesh.kumar@example.in"],
    "PASSWORD": ["Demo#Pass-4471"],
    "USERNAME": [REGISTERED_USERNAME],
}
TERMINAL_TEXT = ("Done", "Error", "Blocked", "Stopped")


def extension_id(context, timeout_s: float = 15.0) -> str:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        for worker in context.service_workers:
            if worker.url.startswith("chrome-extension://"):
                return worker.url.split("/")[2]
        time.sleep(0.1)
    raise RuntimeError("extension service worker never appeared; is the build loaded?")


def audit(body: str) -> list[str]:
    return [f"{entity}:{variant}" for entity, variants in SENSITIVE.items() for variant in variants if variant in body]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--out", type=Path, default=REPO / "tools" / "e2e" / "out")
    parser.add_argument("--timeout", type=float, default=180.0)
    parser.add_argument("--task", default=TASK)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    if not EXTENSION_DIR.exists():
        print(f"missing {EXTENSION_DIR}; run: pnpm --filter @aegis/extension run build:debug")
        return 2

    sent: list[dict] = []
    received: list[dict] = []

    launch_args = [] if args.headed else ["--headless=new"]
    launch_args += [
        "--use-gl=angle",
        "--use-angle=vulkan",
        "--enable-unsafe-webgpu",
        "--window-size=1400,900",
        f"--disable-extensions-except={EXTENSION_DIR}",
        f"--load-extension={EXTENSION_DIR}",
    ]

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            user_data_dir="", headless=False, args=launch_args, viewport={"width": 1280, "height": 800}
        )

        def on_request(request) -> None:
            if request.url.startswith(GATEWAY):
                sent.append({"t": time.time(), "method": request.method, "url": request.url, "body": request.post_data or ""})

        def on_response(response) -> None:
            if response.url.startswith(GATEWAY) and response.request.method == "POST":
                try:
                    body = response.text()
                except Exception:  # noqa: BLE001 - a dropped body is recorded as empty
                    body = ""
                received.append({"url": response.url, "status": response.status, "body": body, "server_timing": response.headers.get("server-timing")})

        context.on("request", on_request)
        context.on("response", on_response)

        ext = extension_id(context)
        page = context.new_page()
        page.goto(DEMO_URL, wait_until="load")
        panel = context.new_page()
        panel_logs: list[str] = []
        panel.on("console", lambda m: panel_logs.append(f"[{m.type}] {m.text}"))
        panel.goto(f"chrome-extension://{ext}/sidepanel.html")
        panel.wait_for_function("typeof window.__aegisRunTask === 'function'", timeout=15000)

        page.bring_to_front()
        t0 = time.monotonic()
        panel.evaluate("(task) => { window.__aegisRunTask(task); }", args.task)
        terminal_js = "(words) => { const t = document.body.innerText; return words.some((w) => t.includes(w)); }"
        # The label reads "Running" while in flight; wait for a terminal panel state.
        timed_out = False
        confirmations = 0
        deadline = time.monotonic() + args.timeout
        while True:
            if panel.evaluate(terminal_js, list(TERMINAL_TEXT)):
                break
            if time.monotonic() > deadline:
                timed_out = True
                break
            # A risky action (e.g. click_point) asks the user first; approve it as the user would.
            allow = panel.locator("button", has_text="Allow once")
            if allow.count() > 0:
                confirmations += 1
                allow.first.click()
            time.sleep(0.25)
        elapsed = time.monotonic() - t0
        time.sleep(1.0)  # let the final settle/graph messages land

        panel_text = panel.evaluate("document.body.innerText")
        ledger = panel.evaluate("window.__aegisLedgerExport ? window.__aegisLedgerExport() : []")
        username_value = page.evaluate("document.getElementById('username').value")
        result_text = page.evaluate("document.getElementById('result').hidden ? '' : document.getElementById('result').textContent")
        page.screenshot(path=str(args.out / "page-after.png"))
        panel.screenshot(path=str(args.out / "panel-after.png"), full_page=True)
        context.close()

    step_bodies = [r for r in sent if r["url"].endswith("/steps")]
    leaks: list[str] = []
    for i, request in enumerate(step_bodies, 1):
        leaks += [f"step{i}:{hit}" for hit in audit(request["body"])]
        try:
            payload = json.loads(request["body"])
        except json.JSONDecodeError:
            continue
        image = payload.get("image")
        if image and image.get("data"):
            (args.out / f"step{i}-sent-image.webp").write_bytes(base64.b64decode(image["data"]))
            payload["image"] = {**image, "data": f"<{len(image['data'])} b64 chars>"}
        (args.out / f"step{i}-sent.json").write_text(json.dumps(payload, indent=2, ensure_ascii=False))
    for i, response in enumerate([r for r in received if r["url"].endswith("/steps")], 1):
        (args.out / f"step{i}-received.json").write_text(json.dumps(response, indent=2, ensure_ascii=False))
    (args.out / "panel-console.log").write_text("\n".join(panel_logs))
    (args.out / "ledger.json").write_text(json.dumps(ledger, indent=2, ensure_ascii=False, default=str)[:2_000_000])

    task_ok = username_value == REGISTERED_USERNAME and result_text.startswith("Signed in as")
    summary = {
        "task": args.task,
        "elapsed_s": round(elapsed, 1),
        "timed_out": timed_out,
        "gateway_requests": [f"{r['method']} {r['url'].replace(GATEWAY, '')}" for r in sent],
        "step_responses": [{"status": r["status"], "server_timing": r["server_timing"]} for r in received if r["url"].endswith("/steps")],
        "images_sent": sum(1 for r in step_bodies if '"image": {' in r["body"] or '"image":{' in r["body"]),
        "leaks": leaks,
        "page_username_value_matches": username_value == REGISTERED_USERNAME,
        "page_result": result_text,
        "panel_state_line": panel_text.splitlines()[:4],
        "user_confirmations": confirmations,
        "task_succeeded": task_ok,
    }
    (args.out / "summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))
    return 0 if task_ok and not leaks else 1


if __name__ == "__main__":
    sys.exit(main())

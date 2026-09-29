"""Runs one task on any URL through the real extension and the running gateway, and reports what
crossed the network boundary: step statuses, payload sizes, how many nodes/text runs were sent,
the prompt size the gateway builds from it, whether an image was sent, and the panel's final
state. Pair it with tools/e2e/fake_vlm.py (FAKE_VLM_SCENARIO=probe) to check real sites without
spending VLM quota, or with the live gateway for a real run.

    eval/.venv/bin/python tools/e2e/probe_site.py https://en.wikipedia.org/wiki/India "Scroll down"

Artifacts (sent payloads, redacted images, plans, screenshots) go to tools/e2e/out/probe-<host>/.
Page text is written only to that local folder, never printed.
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "server" / "gateway" / "src"))
from aegis_gateway.prompt import build_messages  # noqa: E402

EXTENSION_DIR = REPO / "apps" / "extension" / ".output" / "chrome-mv3-dev"
GATEWAY = "http://localhost:8787"
TERMINAL = ("Done", "Error", "Blocked", "Idle")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("task")
    parser.add_argument("--headed", action="store_true")
    parser.add_argument(
        "--watch",
        action="store_true",
        help="a run the user watches: headed, page window left + AEGIS panel window right, run log opened at the end",
    )
    parser.add_argument("--hold", type=float, default=20.0, help="--watch: seconds to keep both windows open after the run")
    parser.add_argument("--timeout", type=float, default=150.0)
    parser.add_argument("--scale", type=float, default=1.0, help="device scale factor (browser zoom / HiDPI)")
    parser.add_argument("--click", action="append", default=[], help="exact visible text to click before the task (repeatable)")
    parser.add_argument("--fill", action="append", default=[], help="synthetic value typed into the next visible text-like input, in page order (repeatable); audited as must-not-leak")
    parser.add_argument("--expect", help="text that must be on the page after the task")
    parser.add_argument("--gateway", help="server URL the extension uses (default: its build-time URL, :8787)")
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=800)
    args = parser.parse_args()
    if args.watch:
        args.headed = True
    out = REPO / "tools" / "e2e" / "out" / f"probe-{urlparse(args.url).hostname}"
    out.mkdir(parents=True, exist_ok=True)

    sent: list[dict] = []
    received: list[dict] = []
    launch_args = [] if args.headed else ["--headless=new"]
    launch_args += [
        f"--force-device-scale-factor={args.scale}",
        f"--disable-extensions-except={EXTENSION_DIR}",
        f"--load-extension={EXTENSION_DIR}",
    ]
    with sync_playwright() as p:
        size = {"no_viewport": True} if args.watch else {"viewport": {"width": args.width, "height": args.height}}
        context = p.chromium.launch_persistent_context(user_data_dir="", headless=False, args=launch_args, **size)
        context.on("request", lambda r: r.url.endswith("/steps") and sent.append({"body": r.post_data or ""}))

        def on_response(r) -> None:
            if r.url.endswith("/steps"):
                try:
                    body = r.text()
                except Exception:  # noqa: BLE001
                    body = ""
                received.append({"status": r.status, "body": body, "timing": r.headers.get("server-timing")})

        context.on("response", on_response)
        # Wait for the event, not a time.sleep poll: the sync API delivers events only while it waits.
        workers = [w for w in context.service_workers if w.url.startswith("chrome-extension://")]
        if not workers:
            workers = [context.wait_for_event("serviceworker", predicate=lambda w: w.url.startswith("chrome-extension://"), timeout=30000)]
        ext = workers[0].url.split("/")[2]

        page = context.new_page()
        t_load = time.monotonic()
        page.goto(args.url, wait_until="domcontentloaded", timeout=45000)
        try:
            page.wait_for_load_state("networkidle", timeout=10000)
        except Exception:  # noqa: BLE001 - busy pages never go idle
            pass
        for text in args.click:
            page.get_by_text(text, exact=True).first.click()
            page.wait_for_timeout(4000)
        if args.fill:
            fields = page.locator("input:visible:not([type=radio]):not([type=checkbox]):not([type=hidden]):not([type=submit]):not([type=button]), textarea:visible")
            for i, value in enumerate(args.fill):
                fields.nth(i).fill(value)
        load_s = time.monotonic() - t_load
        # What the page itself received clicks on (page context, so it sees exactly what a user
        # click would): the id/name/text of each click target, for grounding checks.
        page.evaluate("""() => { window.__aegisClicks = []; document.addEventListener('click', (e) => {
            const t = e.target; window.__aegisClicks.push(t.id || t.name || (t.innerText || '').trim().slice(0, 30) || t.tagName);
        }, true); }""")
        panel = context.new_page()
        logs: list[str] = []
        panel.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
        page_logs: list[str] = []  # the page's console, content-script errors included (local file only)
        page.on("console", lambda m: page_logs.append(f"[{m.type}] {m.text}"[:300]))
        page.on("pageerror", lambda e: page_logs.append(f"[pageerror] {e}"[:300]))
        panel.goto(f"chrome-extension://{ext}/sidepanel.html")
        panel.wait_for_function("typeof window.__aegisRunTask === 'function'", timeout=15000)
        if args.gateway:
            panel.evaluate("(u) => chrome.storage.local.set({ aegis_settings: { serverUrl: u } })", args.gateway)
            panel.reload()
            panel.wait_for_function("typeof window.__aegisRunTask === 'function'", timeout=15000)
            time.sleep(0.5)
        target_tab = None
        if args.watch:
            # The panel moves into its own window beside the page, so the page stays the front tab
            # of its window (what capture needs) while the run log is visible the whole time.
            target_tab = panel.evaluate(
                """async (u) => {
                  const tabs = await chrome.tabs.query({});
                  const t = tabs.find((x) => x.url === u) ?? tabs.find((x) => !x.url.startsWith('chrome-extension://'));
                  const me = await chrome.tabs.getCurrent();
                  await chrome.windows.update(t.windowId, { state: 'normal', left: 0, top: 0, width: 1280, height: 1000 });
                  await chrome.windows.create({ tabId: me.id, left: 1280, top: 0, width: 640, height: 1000, focused: false });
                  await chrome.windows.update(t.windowId, { focused: true });
                  return t.id;
                }""",
                page.url,
            )
        page.bring_to_front()
        t0 = time.monotonic()
        panel.evaluate("(a) => { window.__aegisRunTask(a[0], undefined, a[1] ?? undefined); }", [args.task, target_tab])
        time.sleep(1.0)
        timed_out = False
        while True:
            state = panel.evaluate("document.querySelector('p')?.innerText ?? ''")
            if any(state.startswith(w) for w in TERMINAL):
                break
            allow = panel.locator("button", has_text="Allow once")
            if allow.count() > 0:
                if args.watch:
                    time.sleep(2.5)  # long enough to see the card before it is allowed
                allow.first.click()
            if time.monotonic() - t0 > args.timeout:
                timed_out = True
                break
            time.sleep(0.3)
        elapsed = time.monotonic() - t0
        panel.screenshot(path=str(out / "panel-collapsed.png"), full_page=True)
        # The run log's sections are <details>: open them all so the text and screenshot hold everything.
        panel.evaluate("document.querySelectorAll('details').forEach((d) => { d.open = true; })")
        panel_text = panel.evaluate("document.body.innerText")
        if args.watch:
            print(f"run finished in {elapsed:.1f} s; holding the windows for {args.hold:.0f} s", file=sys.stderr, flush=True)
            time.sleep(args.hold)
        page.screenshot(path=str(out / "page-after.png"))
        panel.screenshot(path=str(out / "panel-after.png"), full_page=True)
        (out / "panel-console.log").write_text("\n".join(logs))
        (out / "page-console.log").write_text("\n".join(page_logs))
        final_url = page.url
        clicks = page.evaluate("window.__aegisClicks || []") if urlparse(page.url).path == urlparse(args.url).path else None
        expect_ok = (args.expect in page.inner_text("body")) if args.expect else None
        context.close()

    steps = []
    for i, request in enumerate(sent, 1):
        try:
            payload = json.loads(request["body"])
        except json.JSONDecodeError:
            continue
        image = payload.get("image")
        prompt_chars = sum(
            len(part["text"]) if isinstance(part, dict) and part.get("type") == "text" else 0
            for m in build_messages(payload)
            for part in (m["content"] if isinstance(m["content"], list) else [{"type": "text", "text": m["content"]}])
        )
        if image:
            (out / f"step{i}-sent-image.webp").write_bytes(base64.b64decode(image["data"]))
            payload["image"] = {**image, "data": f"<{len(image['data'])} b64>"}
        (out / f"step{i}-sent.json").write_text(json.dumps(payload, indent=1, ensure_ascii=False))
        steps.append({
            "bytes": len(request["body"]),
            "nodes": len(payload.get("nodes", [])),
            "text_runs": len(payload.get("text", [])),
            "redactions": sorted({r["entity"] for r in payload.get("redactions", [])}),
            "image": bool(image),
            "coverage": payload.get("coverage"),
            "prompt_text_chars": prompt_chars,
        })
    for i, r in enumerate(received, 1):
        (out / f"step{i}-received.json").write_text(json.dumps(r, indent=1, ensure_ascii=False))

    leaks = sorted({v for v in args.fill if len(v) >= 4 and any(v in r["body"] for r in sent)})
    lines = panel_text.splitlines()
    summary = {
        "url_host": urlparse(args.url).hostname,
        "navigated": urlparse(final_url).path != urlparse(args.url).path,
        "load_s": round(load_s, 1),
        "task_s": round(elapsed, 1),
        "timed_out": timed_out,
        "panel_state": lines[2] if len(lines) > 2 else "",
        "panel_error": next((l for l in lines if l.startswith("Error:")), None),
        "panel_perception": [l for l in lines if l.startswith(("Perception", "ran:", "crops:", "redactions by source", "Redactions"))],
        "filled_values_leaked": leaks,
        "page_clicks": clicks,
        "expect_found": expect_ok,
        "viewport": [args.width, args.height, args.scale],
        "panel_activity": panel_text[panel_text.find("3. Server reply"):][:900] if "3. Server reply" in panel_text else None,
        "panel_protected": next((l for l in lines if l.startswith("Protected fields")), None),
        "panel_pipeline": panel_text[panel_text.find("Run order"):panel_text.find("2. Sent to the server")] if "Run order" in panel_text else None,
        "steps": steps,
        "responses": [{"status": r["status"], "timing": r["timing"], "body": r["body"][:300]} for r in received],
        "out": str(out),
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=1))
    print(json.dumps(summary, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())

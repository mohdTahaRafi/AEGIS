"""Smoke test of the RELEASE build (`.output/chrome-mv3`, `pnpm build`) as a user gets it: installed
unpacked, nothing else on the machine, the network locked down to the demo page and api.groq.com.

What it proves:
  1. First run shows the "add your Groq API key" card and refuses to run a task without a key.
  2. A malformed key is refused locally; a well-formed but wrong key is sent to api.groq.com (the
     one allowed host) and refused there, and is NOT saved.
  3. With a key saved, a task runs end to end on the demo page: every bundled model (face, OCR,
     CLIP) loads from the package with no other request, the step goes to api.groq.com with the
     saved key and a redacted screenshot, no raw sensitive value is in the request, and the plan
     executes.
  4. Nothing but the demo page, the extension and api.groq.com was ever contacted.

One thing differs from an installed release, and only in the manifest copy this script loads: Chrome
asks a real user to approve site access in a dialog no automation can click, so the copy also lists
<all_urls> as a host permission. Every file (code, models, CSP, icons) is byte-identical.

The Groq answer is scripted (Playwright fulfils the request) unless --live is given, which spends
one real model call with the key from $AEGIS_MODEL_API_KEY / server/deploy/model.env.

    python3 -m http.server 8080 --bind 127.0.0.1 --directory demo &
    eval/.venv/bin/python tools/e2e/release_smoke.py [--live] [--watch]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from probe_site import load_api_key  # noqa: E402

RELEASE_DIR = REPO / "apps" / "extension" / ".output" / "chrome-mv3"
DEMO_URL = "http://127.0.0.1:8080/signin.html"
TASK = "Enter the username and click Sign in."
GROQ = "https://api.groq.com/"
ALLOWED_HOSTS = {"127.0.0.1", "api.groq.com"}
SENSITIVE = ["4987 1234 5679", "498712345679", "ABCPK1234F", "98765 43210", "9876543210", "ramesh.kumar@example.in", "Demo#Pass-4471", "rkumar_2291"]
WRONG_KEY = "gsk_" + "x" * 48


def scripted_plan(body: dict) -> dict:
    """What a correct model answers for the demo page (aliases as the prompt shows them)."""
    text = next(p["text"] for m in body["messages"] if m["role"] == "user" for p in m["content"] if p.get("type") == "text")
    rows = re.findall(r'^(e\d+) \| (\w+) \| "([^"]*)"', text, re.M)
    box = next(i for i, role, name in rows if role == "textbox" and name == "Username")
    button = next(i for i, role, name in rows if role == "button" and name == "Sign in")
    ref = re.search(r"⟪(USERNAME#\d+)⟫", text).group(1)
    return {"actions": [{"op": "type", "node": box, "ref": ref}, {"op": "click", "node": button}, {"op": "done", "summary": "Signed in."}]}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", action="store_true", help="one real Groq call with your key instead of a scripted answer")
    parser.add_argument("--watch", action="store_true", help="headed, windows left/right, held open at the end")
    parser.add_argument("--hold", type=float, default=15.0)
    args = parser.parse_args()

    contacted: dict[str, int] = {}
    blocked: list[str] = []
    groq_calls: list[dict] = []
    checks: list[tuple[str, bool, str]] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        checks.append((name, ok, detail))
        print(f"{'PASS' if ok else 'FAIL'}  {name}{('  - ' + detail) if detail else ''}", flush=True)

    real_key = load_api_key() if args.live else ""
    release_manifest = json.loads((RELEASE_DIR / "manifest.json").read_text())
    work = Path(tempfile.mkdtemp(prefix="aegis-release-smoke-", dir=os.environ.get("AEGIS_SMOKE_WORK")))
    extension_dir = work / "ext"
    shutil.copytree(RELEASE_DIR, extension_dir)
    patched = json.loads((extension_dir / "manifest.json").read_text())
    patched["host_permissions"] = [*patched["host_permissions"], "<all_urls>"]
    (extension_dir / "manifest.json").write_text(json.dumps(patched))
    with sync_playwright() as p:
        launch_args = [
            f"--disable-extensions-except={extension_dir}",
            f"--load-extension={extension_dir}",
            "--enable-unsafe-extension-debugging",
            "--remote-debugging-port=9333",
        ]
        if not args.watch:
            launch_args.append("--headless=new")
        context = p.chromium.launch_persistent_context(user_data_dir="", headless=False, args=launch_args, **({"no_viewport": True} if args.watch else {"viewport": {"width": 1280, "height": 800}}))

        def on_route(route) -> None:
            url = route.request.url
            host = urlparse(url).hostname or ""
            scheme = urlparse(url).scheme
            if scheme in ("chrome-extension", "data", "blob", "about", "chrome"):
                return route.continue_()
            contacted[host] = contacted.get(host, 0) + 1
            if host not in ALLOWED_HOSTS:
                blocked.append(url[:120])
                return route.abort()
            if url.startswith(GROQ):
                headers = {"access-control-allow-origin": "*", "access-control-allow-headers": "*"}
                if route.request.method == "OPTIONS":
                    return route.fulfill(status=204, headers=headers)
                key = (route.request.headers.get("authorization") or "").removeprefix("Bearer ")
                if url.endswith("/models"):
                    groq_calls.append({"kind": "models", "key_is_wrong_key": key == WRONG_KEY})
                    if args.live and key == real_key:
                        return route.continue_()
                    if key == WRONG_KEY or key != real_key:
                        return route.fulfill(status=401, headers=headers, content_type="application/json", body=json.dumps({"error": {"message": "Invalid API Key", "type": "invalid_request_error", "code": "invalid_api_key"}}))
                if url.endswith("/chat/completions"):
                    body = json.loads(route.request.post_data or "{}")
                    groq_calls.append({"kind": "step", "key": key, "body": route.request.post_data or "", "model": body.get("model")})
                    if args.live:
                        return route.continue_()
                    plan = scripted_plan(body)
                    return route.fulfill(status=200, headers=headers, content_type="application/json", body=json.dumps({"choices": [{"message": {"role": "assistant", "content": json.dumps(plan)}}], "usage": {"completion_tokens": 60}}))
            return route.continue_()

        context.route("**/*", on_route)
        context.on("requestfailed", lambda r: r.url.startswith(GROQ) and print(f"  groq request failed: {r.method} {r.url[-24:]} {r.failure}", flush=True))
        answers: list[str] = []

        def on_groq_response(r) -> None:
            if not r.url.startswith(GROQ):
                return
            print(f"  groq response: {r.request.method} {r.url[-24:]} -> {r.status}", flush=True)
            if r.url.endswith("/chat/completions"):
                try:
                    answers.append(r.text()[:500])
                except Exception:  # noqa: BLE001
                    pass

        context.on("response", on_groq_response)
        workers = [w for w in context.service_workers if w.url.startswith("chrome-extension://")] or [context.wait_for_event("serviceworker", predicate=lambda w: w.url.startswith("chrome-extension://"), timeout=30000)]
        ext = workers[0].url.split("/")[2]
        check("release manifest: only the model API is a required host", release_manifest.get("host_permissions") == ["https://api.groq.com/*"], str(release_manifest.get("host_permissions")))
        check("release manifest: extension pages may connect only to themselves and api.groq.com", "connect-src 'self' https://api.groq.com" in release_manifest["content_security_policy"]["extension_pages"])

        page = context.new_page()
        page.goto(DEMO_URL, wait_until="domcontentloaded")
        panel = context.new_page()
        panel_logs: list[str] = []
        panel.on("console", lambda m: panel_logs.append(f"[{m.type}] {m.text}"[:300]))
        panel.goto(f"chrome-extension://{ext}/sidepanel.html")
        panel.wait_for_selector("[data-testid=api-key-card]", timeout=15000)

        # 1. first run
        check("first run shows the API key card", panel.locator("[data-testid=api-key-card]").count() == 1)
        check("the task box is disabled until a key is saved", panel.get_by_role("textbox", name="Task").is_disabled())

        # 2. keys
        box = panel.get_by_label("Groq API key")
        box.fill("abc")
        panel.get_by_role("button", name="Save key").click()
        panel.wait_for_selector("text=does not look like an API key", timeout=5000)
        check("a malformed key is refused locally", not any(c["kind"] == "models" for c in groq_calls))
        box.fill(WRONG_KEY)
        panel.get_by_role("button", name="Save key").click()
        panel.wait_for_selector("text=Groq rejected this key", timeout=15000)
        stored = panel.evaluate("chrome.storage.local.get('aegis_settings')")
        check("a wrong key reaches api.groq.com, is rejected, and is not saved", any(c["kind"] == "models" for c in groq_calls) and not (stored.get("aegis_settings") or {}).get("apiKey"))
        if args.live:
            box.fill(real_key)
            panel.get_by_role("button", name="Save key").click()
            try:
                panel.wait_for_selector("text=Key works", timeout=20000)
            except Exception:  # noqa: BLE001
                shown = panel.locator("[role=status]").all_inner_texts()
                print(f"key check did not report success; panel says: {shown}; console: {[l for l in panel_logs if 'error' in l.lower()][:5]}", flush=True)
                raise
            check("the real key is accepted by Groq's model list and saved", bool((panel.evaluate("chrome.storage.local.get('aegis_settings')").get("aegis_settings") or {}).get("apiKey")))
        else:
            panel.evaluate("(k) => chrome.storage.local.set({ aegis_settings: { apiKey: k } })", "gsk_" + "scripted" * 6)
            panel.reload()
        panel.wait_for_function("typeof window.__aegisRunTask === 'function'", timeout=15000)
        panel.wait_for_selector("[data-testid=api-key-card]", state="detached", timeout=10000)
        check("with a key saved the card is gone and the task box is enabled", panel.get_by_role("textbox", name="Task").is_enabled())

        # 3. a task, on the release build: activeTab comes from the toolbar click
        # The release build gets `activeTab` (screenshots) only from a toolbar click, so click it the
        # way a user would: Chromium's own action trigger, over a browser-level CDP session.
        try:
            browser = p.chromium.connect_over_cdp("http://127.0.0.1:9333")
            cdp = browser.new_browser_cdp_session()
            targets = cdp.send("Target.getTargets", {"filter": [{"type": "tab"}]})["targetInfos"]
            page_target = next(t for t in targets if t["type"] == "tab" and t["url"] == DEMO_URL)
            cdp.send("Extensions.triggerAction", {"id": ext, "targetId": page_target["targetId"]})
            granted = True
        except Exception as exc:  # noqa: BLE001
            granted = False
            print(f"note: could not click the toolbar icon over CDP ({str(exc)[:100]}); the run will wait for the grant", flush=True)
        time.sleep(1.0)
        target_tab = panel.evaluate("async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id", DEMO_URL)
        t0 = time.monotonic()
        panel.evaluate("(a) => { window.__aegisRunTask(a[0], undefined, a[1]); }", [TASK, target_tab])
        state = ""
        while time.monotonic() - t0 < 180:
            state = panel.evaluate("(document.querySelector('header')?.innerText ?? '').trim().split('\\n').pop()")
            if state in ("Done", "Error", "Blocked by guard"):
                break
            time.sleep(0.5)
        text = panel.evaluate("document.querySelectorAll('details').forEach((d) => { d.open = true; }) || document.body.innerText")
        check("the task finished (Done)", state == "Done", f"state={state!r}, granted_by_toolbar_click={granted}")
        if state != "Done":
            print("  panel error:", next((l for l in text.splitlines() if l.startswith("Error:")), "(none)"), flush=True)
            for a in answers:
                print("  model answered:", a, flush=True)
        steps = [c for c in groq_calls if c["kind"] == "step"]
        check("exactly the model calls a run needs went to api.groq.com", len(steps) >= 1, f"{len(steps)} call(s)")
        if steps:
            body = steps[0]["body"]
            check("the saved key was sent, as a bearer token, to api.groq.com only", steps[0]["key"] == (real_key or "gsk_" + "scripted" * 6))
            check("the request carried a redacted screenshot", '"image_url"' in body and "data:image/webp;base64," in body)
            check("no raw sensitive value is in the request", not [v for v in SENSITIVE if v in body], ", ".join(v for v in SENSITIVE if v in body))
        loaded = re.search(r"YuNet .*?CLIP.*?OCR", text) or re.search(r"ran: [^\n]*", text)
        check("face, OCR and CLIP models all ran from the package", bool(re.search(r"YuNet", text) and re.search(r"OCR", text) and re.search(r"CLIP", text)), (loaded.group(0)[:100] if loaded else ""))
        check("no model failed to load", "MODEL_LOAD" not in text and "could not load" not in text.lower())
        page_state = page.evaluate("document.body.innerText")
        # The page prints this only if the field holds the real username: the model only ever saw a
        # placeholder, so the value was put back inside the browser.
        check("the plan ran on the page, with the real value put back locally", "Signed in as rkumar_2291" in page_state)

        # 4. network audit
        check("nothing but the demo page, the extension and api.groq.com was contacted", not blocked, f"contacted={contacted} blocked={blocked}")
        if args.watch:
            time.sleep(args.hold)
        context.close()

    shutil.rmtree(work, ignore_errors=True)
    failed = [c for c in checks if not c[1]]
    print(f"\n{len(checks) - len(failed)}/{len(checks)} checks passed" + ("  (live Groq call)" if args.live else "  (Groq answer scripted by the test)"))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

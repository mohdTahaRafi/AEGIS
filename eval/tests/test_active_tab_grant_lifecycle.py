"""2026-09-28 — Chrome's activeTab grant lifecycle, end to end, in a real headed browser.

The bug: capture worked on some real sites and failed on others (Practo, Passport Seva) with
"activeTab not granted" even though the user had clicked the AEGIS icon. Reproduced in Chrome
144.0.7559.96: the grant is given to the tab's CURRENT origin and Chrome withdraws it on any
cross-origin navigation (www.practo.com → accounts.practo.com, www.passportindia.gov.in →
services2.passportindia.gov.in). The task then silently ran DOM-only. Now the step pauses, before
anything is sent, and asks for a toolbar invocation on the task's tab.

This test reproduces that deterministically with no internet: one fixture server, reached as
http://127.0.0.1:P and http://localhost:P — two different origins to Chrome.

What makes it real rather than a mock:
- the unmodified production build (`apps/extension/.output/chrome-mv3`), loaded through CDP
  `Extensions.loadUnpacked` (branded Chrome ignores --load-extension since 137);
- the toolbar action is invoked with a real X11 keystroke bound to `_execute_action`, the same
  ExtensionActionRunner path as a mouse click (Chrome 144 has no CDP Extensions.triggerAction; a
  CDP-synthesised key never reaches browser accelerators);
- the task runs in the real side panel document Chrome opened, driven over CDP with user-gesture
  evaluation, exactly like a click on Run (so the host-permission prompt is real too);
- the gateway is a local HTTP stub that records every request body.

Needs: Xvfb, python-xlib, and Chrome (AEGIS_CHROME, else /usr/bin/google-chrome, else Playwright's
Chromium). Skipped when any is missing.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from collections.abc import Iterator
from functools import partial
from http.server import BaseHTTPRequestHandler, SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from aegis_eval.runner.browser import EXTENSION_DIR, REPO_ROOT

xlib = pytest.importorskip(
    "Xlib", reason="python-xlib is needed to press the real toolbar-action shortcut"
)
from playwright.sync_api import sync_playwright  # noqa: E402
from Xlib import XK, X  # noqa: E402
from Xlib import display as xdisplay  # noqa: E402
from Xlib.ext import xtest  # noqa: E402

FIXTURES = REPO_ROOT / "apps" / "extension" / "test" / "fixtures"
RAW_SECRETS = ["2345 6789 0124", "234567890124", "hunter2-correct-battery"]
TASK = "log in and submit the form"

pytestmark = [
    pytest.mark.skipif(shutil.which("Xvfb") is None, reason="Xvfb not installed"),
    pytest.mark.skipif(
        not (EXTENSION_DIR / "manifest.json").exists(), reason="extension not built"
    ),
]


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class _Stub(BaseHTTPRequestHandler):
    bodies: list[dict] = []

    def log_message(self, *args: object) -> None:
        pass

    def _json(self, status: int, obj: object) -> None:
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802
        raw = self.rfile.read(int(self.headers.get("content-length", 0))).decode("utf-8", "replace")
        _Stub.bodies.append({"path": self.path, "body": raw})
        if self.path == "/v1/sessions":
            return self._json(
                201,
                {
                    "session_id": f"s{len(_Stub.bodies)}",
                    "model": "stub",
                    "mode": "replay",
                    "limits": {"max_steps": 30, "max_image_px": 1600000},
                },
            )
        return self._json(
            200,
            {
                "step_id": json.loads(raw).get("step_id", "s-1"),
                "actions": [{"op": "done", "summary": "stub"}],
            },
        )

    def do_DELETE(self) -> None:  # noqa: N802
        self.send_response(204)
        self.end_headers()


def _serve(handler: type[BaseHTTPRequestHandler] | partial, port: int) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def _chrome() -> str | None:
    for candidate in (os.environ.get("AEGIS_CHROME"), "/usr/bin/google-chrome"):
        if candidate and Path(candidate).exists():
            return candidate
    return None


class _PanelTarget:
    """Runtime.evaluate in the real side panel (not a Playwright page), via the browser session."""

    def __init__(self, bcdp, pump, target_id: str) -> None:
        self.b, self.pump, self.next_id, self.replies = bcdp, pump, 0, {}
        self.sid = bcdp.send("Target.attachToTarget", {"targetId": target_id, "flatten": False})[
            "sessionId"
        ]
        bcdp.on("Target.receivedMessageFromTarget", self._on)

    def _on(self, params: dict) -> None:
        if params.get("sessionId") == self.sid:
            msg = json.loads(params["message"])
            if "id" in msg:
                self.replies[msg["id"]] = msg

    def evaluate(self, expression: str, gesture: bool = False, timeout: float = 30):
        self.next_id += 1
        mid = self.next_id
        cmd = {
            "id": mid,
            "method": "Runtime.evaluate",
            "params": {
                "expression": expression,
                "awaitPromise": True,
                "returnByValue": True,
                "userGesture": gesture,
            },
        }
        self.b.send(
            "Target.sendMessageToTarget", {"sessionId": self.sid, "message": json.dumps(cmd)}
        )
        deadline = time.time() + timeout
        while mid not in self.replies:
            assert time.time() < deadline, f"panel evaluate timed out: {expression[:60]}"
            self.pump(30)
        result = self.replies.pop(mid)["result"]
        assert "exceptionDetails" not in result, json.dumps(result["exceptionDetails"])[:300]
        return result["result"].get("value")


class Harness:
    def __init__(self, ctx, bcdp, ext_id: str, disp: str, stub_url: str) -> None:
        self.ctx, self.b, self.ext_id, self.disp, self.stub_url = ctx, bcdp, ext_id, disp, stub_url
        self.admin = ctx.new_page()
        self.admin.goto("chrome://extensions")
        self.pump = self.admin.wait_for_timeout
        self.admin.evaluate(
            "() => chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode: true})"
        )
        self.admin.evaluate(
            "(id) => chrome.developerPrivate.updateExtensionCommand({extensionId: id, "
            "commandName: '_execute_action', keybinding: 'Alt+Shift+Y'})",
            ext_id,
        )
        self.panel: _PanelTarget | None = None
        self.panel_id: str | None = None

    def keys(self, *names: str) -> None:
        d = xdisplay.Display(self.disp)
        xtest.fake_input(d, X.MotionNotify, x=600, y=450)
        codes = [d.keysym_to_keycode(XK.string_to_keysym(n)) for n in names]
        for c in codes:
            xtest.fake_input(d, X.KeyPress, c)
            d.sync()
            time.sleep(0.03)
        for c in reversed(codes):
            xtest.fake_input(d, X.KeyRelease, c)
        d.sync()
        d.close()

    def invoke(self, page) -> None:
        """What the user does: click the AEGIS toolbar icon with `page` in front."""
        page.bring_to_front()
        self.pump(300)
        self.keys("Alt_L", "Shift_L", "y")
        self.pump(900)

    def reload_extension(self) -> None:
        self.admin.evaluate(
            "(id) => chrome.developerPrivate.reload(id, {failQuietly: true})", self.ext_id
        )
        self.pump(3000)
        self.panel = None

    def _panel(self) -> _PanelTarget:
        url = f"chrome-extension://{self.ext_id}/sidepanel.html"
        ids = [
            t["targetId"]
            for t in self.b.send("Target.getTargets")["targetInfos"]
            if t["type"] == "page" and t["url"] == url
        ]
        if self.panel is not None and self.panel_id in ids:
            return self.panel
        assert ids, "the toolbar invocation did not open the side panel"
        self.panel, self.panel_id = _PanelTarget(self.b, self.pump, ids[0]), ids[0]
        self.panel.evaluate(
            "chrome.storage.local.get('aegis_settings').then(r => "
            "chrome.storage.local.set({aegis_settings: {...(r.aegis_settings || {}), "
            f"serverUrl: {json.dumps(self.stub_url)}, accessToken: 'dev-token'}}}}))"
        )
        self.panel.evaluate("location.reload(); 1")
        deadline = time.time() + 20
        while True:
            try:
                if self.panel.evaluate("typeof window.__aegisRunTask === 'function'"):
                    return self.panel
            except AssertionError:
                pass
            assert time.time() < deadline, "panel never became ready"
            self.pump(200)

    def run(self, page, on_card=None) -> dict:
        panel = self._panel()
        page.bring_to_front()
        self.pump(300)
        steps_before = sum(1 for b in _Stub.bodies if b["path"].endswith("/steps"))
        sessions_before = sum(1 for b in _Stub.bodies if b["path"] == "/v1/sessions")
        t0 = time.time()
        panel.evaluate(f"window.__aegisRunTask({json.dumps(TASK)}); 1", gesture=True)
        out: dict = {"card": None, "steps_while_waiting": None}
        prompt_answered = False
        while True:
            state = panel.evaluate("document.querySelector('p')?.textContent || ''")
            text = panel.evaluate("document.body.innerText")
            if out["card"] is None and "Screenshot access needed" in text:
                out["card"] = " ".join(text[text.index("Screenshot access needed") :].split())
                out["steps_while_waiting"] = (
                    sum(1 for b in _Stub.bodies if b["path"].endswith("/steps")) - steps_before
                )
                if on_card:
                    on_card(panel)
            if (
                state in ("Done", "Error", "Blocked by guard", "No permission for this site")
                and time.time() - t0 > 1
            ):
                break
            opened = sum(1 for b in _Stub.bodies if b["path"] == "/v1/sessions") > sessions_before
            if not prompt_answered and state == "Loading" and time.time() - t0 > 3 and not opened:
                # First run on an origin: the real host-permission prompt. Focus starts on Deny.
                self.keys("Tab")
                self.pump(200)
                self.keys("Return")
                prompt_answered = True
            assert time.time() - t0 < 180, (
                f"no terminal state; panel: {' '.join(text.split())[:400]}"
            )
            self.pump(250)
        ledger = json.loads(panel.evaluate("JSON.stringify(window.__aegisLedgerExport())") or "[]")
        out.update(state=state, text=panel.evaluate("document.body.innerText"), ledger=ledger)
        return out

    def goto(self, page, url: str) -> None:
        page.goto(url, wait_until="load")
        self.pump(800)


@pytest.fixture(scope="module")
def harness() -> Iterator[Harness]:
    disp = f":{_free_port() % 400 + 100}"
    xvfb = subprocess.Popen(
        ["Xvfb", disp, "-screen", "0", "1600x1000x24", "-nolisten", "tcp"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(1)
    fixture_port, stub_port = _free_port(), _free_port()
    fixtures = _serve(partial(SimpleHTTPRequestHandler, directory=str(FIXTURES)), fixture_port)
    stub = _serve(_Stub, stub_port)
    try:
        with sync_playwright() as p:
            ctx = p.chromium.launch_persistent_context(
                tempfile.mkdtemp(),
                executable_path=_chrome(),
                headless=False,
                viewport=None,
                env={**os.environ, "DISPLAY": disp},
                ignore_default_args=["--disable-extensions"],
                args=[
                    "--enable-unsafe-extension-debugging",
                    "--window-position=0,0",
                    "--window-size=1500,950",
                ],
            )
            bcdp = ctx.browser.new_browser_cdp_session()
            ext_id = bcdp.send("Extensions.loadUnpacked", {"path": str(EXTENSION_DIR)})["id"]
            h = Harness(ctx, bcdp, ext_id, disp, f"http://127.0.0.1:{stub_port}")
            h.a = f"http://127.0.0.1:{fixture_port}"  # type: ignore[attr-defined]
            h.b_origin = f"http://localhost:{fixture_port}"  # type: ignore[attr-defined]
            yield h
            ctx.close()
    finally:
        fixtures.shutdown()
        stub.shutdown()
        xvfb.terminate()


def _step(result: dict) -> dict:
    assert result["ledger"], f"no step recorded; panel: {' '.join(result['text'].split())[:400]}"
    return result["ledger"][0]


def test_invoked_on_the_task_page_captures_on_the_first_step(harness: Harness) -> None:
    page = harness.ctx.new_page()
    harness.goto(page, f"{harness.a}/demo-login.html")
    harness.invoke(page)
    result = harness.run(page)
    assert result["card"] is None
    step = _step(result)
    assert step["perception"]["status"]["capture"] == "ok"
    assert step["perception"]["status"]["worker"] == "ok"
    page.close()


def test_a_same_origin_navigation_after_the_click_keeps_the_grant(harness: Harness) -> None:
    page = harness.ctx.new_page()
    harness.goto(page, f"{harness.a}/demo-login.html")
    harness.invoke(page)
    harness.goto(page, f"{harness.a}/demo-login.html?next=%2Fprofile")
    result = harness.run(page)
    assert result["card"] is None
    assert _step(result)["perception"]["status"]["capture"] == "ok"
    page.close()


def test_a_cross_origin_navigation_after_the_click_pauses_until_the_user_invokes_again(
    harness: Harness,
) -> None:
    """The Practo / Passport Seva sequence."""
    page = harness.ctx.new_page()
    harness.goto(page, f"{harness.a}/demo-login.html")
    harness.invoke(page)
    harness.goto(page, f"{harness.b_origin}/demo-login.html")
    result = harness.run(page, on_card=lambda _panel: harness.invoke(page))
    assert result["card"] is not None, "the step silently fell back to DOM-only instead of asking"
    assert harness.a in result["card"] and harness.b_origin in result["card"]
    assert result["steps_while_waiting"] == 0, (
        "a step was sent to the gateway while waiting for the grant"
    )
    assert result["state"] == "Done"
    step = _step(result)
    assert step["perception"]["status"]["capture"] == "ok"
    assert step["perception"]["status"]["worker"] == "ok"
    page.close()


def test_a_never_invoked_tab_asks_and_waiving_reports_chromes_real_error(harness: Harness) -> None:
    page = harness.ctx.new_page()
    harness.goto(page, f"{harness.b_origin}/demo-login.html?fresh=1")
    click_waive = (
        "[...document.querySelectorAll('button')]"
        ".find(b => b.textContent === 'Continue without screenshots').click(); 1"
    )
    result = harness.run(page, on_card=lambda panel: panel.evaluate(click_waive, gesture=True))
    assert result["card"] is not None and "has not been invoked on this tab" in result["card"]
    status = _step(result)["perception"]["status"]
    assert status["capture"] == "permission"
    assert "activeTab" in status["captureDetail"]
    assert _step(result)["payload"]["image"] is None
    page.close()


def test_extension_reload_with_the_page_left_open_then_invoke(harness: Harness) -> None:
    page = harness.ctx.new_page()
    harness.goto(page, f"{harness.a}/demo-login.html?reload=1")
    harness.reload_extension()
    harness.invoke(page)
    result = harness.run(page)
    assert result["state"] == "Done"
    assert _step(result)["perception"]["status"]["capture"] == "ok"
    page.close()


def test_no_raw_secret_ever_left_the_browser(harness: Harness) -> None:
    steps = [b for b in _Stub.bodies if b["path"].endswith("/steps")]
    assert len(steps) >= 5
    for body in _Stub.bodies:
        for secret in RAW_SECRETS:
            assert secret not in body["body"], f"raw secret in outbound {body['path']}"

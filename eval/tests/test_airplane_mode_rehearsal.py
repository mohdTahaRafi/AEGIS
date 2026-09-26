"""T-7.4/DR-2, made a permanent, repeatable check rather than a one-off manual verification: "local
detection and redaction keep running with the network disconnected." An earlier session (2026-09-19)
found and fixed a real gap where the panel's sanitized-payload view only ever populated *after* a
successful `sendToGateway` round trip, so a network failure left the panel blank even though the
local pipeline had already succeeded — fixed with a `sanitized_preview` session event, proven with
a unit test using a *mocked* rejected `sendToGateway` call (`test/unit/session.spec.ts`).

This test proves the same claim one level more realistically: against the real built extension,
loaded in real Chromium, with the network cut at the browser-context level
(`context.set_offline(True)`) — a genuine denial of every real network request from that context,
not a mocked function call rejecting. `set_offline` is deliberately used instead of disabling the
host machine's actual network interface, which would be a stronger "unplugged cable" claim but
would also sever this very test's own automation and any other process sharing the host's network
— the browser-context-level cut is the precise, safe way to get a real (not simulated) network
failure scoped to only the thing under test.

The network is cut immediately after `POST /v1/sessions` succeeds (not before): opening a session
inherently needs one real round trip to exist at all, so "network already dead before anything
starts" is a different, correctly-fail-closed scenario (`GATEWAY_UNREACHABLE`), not what DR-2's
claim is actually about. The scenario DR-2 cares about, and the one a real demo can actually hit,
is the network dying *mid-task* — after a session is open, before or during a step's own send.
"""

from __future__ import annotations

import time
from pathlib import Path

from aegis_eval.runner.browser import DEBUG_EXTENSION_DIR, extension_context, extension_id

# eval/tests/test_airplane_mode_rehearsal.py -> eval/tests -> eval -> repo root
REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_PATH = REPO_ROOT / "apps" / "extension" / "test" / "fixtures" / "demo-login.html"
FIXTURE_URL = FIXTURE_PATH.as_uri()
TASK = "log in and submit the form"
TERMINAL_MARKERS = ("Done", "Error", "Blocked")


def test_sanitized_payload_survives_the_network_dying_mid_task() -> None:
    with extension_context(headless=True, extension_dir=DEBUG_EXTENSION_DIR) as context:
        ext_id = extension_id(context, timeout_s=15)
        page = context.new_page()
        page.goto(FIXTURE_URL)

        panel = context.new_page()
        went_offline = {"done": False}

        def on_response(res):
            if "/sessions" in res.url and res.request.method == "POST" and "/steps" not in res.url:
                context.set_offline(True)
                went_offline["done"] = True

        panel.on("response", on_response)
        panel.goto(f"chrome-extension://{ext_id}/sidepanel.html")

        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if panel.evaluate("typeof window.__aegisRunTask") == "function":
                break
            time.sleep(0.25)

        page.bring_to_front()
        panel.evaluate(
            f"(() => {{ window.__runPromise = window.__aegisRunTask({TASK!r}, []); return 'fired'; }})()"
        )

        deadline = time.monotonic() + 30
        panel_text = ""
        while time.monotonic() < deadline:
            panel_text = panel.evaluate("document.body.innerText")
            if any(marker in panel_text for marker in TERMINAL_MARKERS):
                break
            time.sleep(0.3)

        context.set_offline(False)

    assert went_offline["done"], "the session-create response was never observed — test setup is broken, not the claim under test"
    assert "Error" in panel_text, "the step call should have failed once offline — if it didn't, the network cut never actually took effect"
    assert "Redactions:" in panel_text, (
        "DR-2's real claim: the panel must still show the sanitized payload (redactions, "
        "coverage) even though the network died mid-task — got a blank/error-only panel instead"
    )

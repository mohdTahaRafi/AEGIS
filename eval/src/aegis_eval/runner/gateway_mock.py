"""phase_5_measurement.md §16a's harness-integration work — a self-contained, in-process stand-in
for the real gateway, so a harness run needs no separately-running server process at all.

Session open/close carry no page data at all (design.md §4.1) so mocking them is inert by
definition. The one call that matters is the step endpoint: the real gateway would ask a live
model for a plan, but no live model exists in this environment (OQ-13, still open) — so this
returns a trivial, schema-valid, hard-coded plan (`report` + `done`) instead. This is NOT a
substitute for real model-in-the-loop testing (metric 1's task-success ratio and metric 5's model
share both need one, and stay unmeasured here — see `scorers/metric1.py`'s and `metric5.py`'s own
disclosed-gap notes); it exists so the sanitized OUTGOING payload — which is what metrics 2 and 3
actually score — is genuinely produced end to end, through the real extension, not synthesized by
hand.

Byte-exact request/response replay (the mechanism `server/gateway`'s own `replay/store.py` uses)
was tried first and abandoned for this purpose: node ids are randomly generated per session by
design (`content/screen-graph/identity.py`'s counterpart in the TS extraction code), so the exact
same fixture produces a different canonical hash on every run — a deliberate anti-fingerprinting
property of the real product, not a bug, but incompatible with hash-keyed replay for harness runs
that don't fix a session up front. Intercepting the HTTP call directly sidesteps that entirely.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field

from playwright.sync_api import BrowserContext, Route

DEFAULT_PLAN = {
    "actions": [
        {"op": "report", "content": "Task observed and reported by the eval harness's mock gateway."},
        {"op": "done", "summary": "Mock gateway run complete — see this module's doc comment."},
    ],
}


@dataclass
class CapturedStep:
    session_id: str
    request_body: dict
    response_plan: dict


@dataclass
class MockGateway:
    """Records every intercepted step request/response pair so the caller (eventually the metric
    2/3 scorers, once the corpus is large enough to be worth scoring — T-5.1) can pull the real
    sanitized payload straight out of here instead of re-parsing ledger exports."""

    captured_steps: list[CapturedStep] = field(default_factory=list)

    def _handle(self, route: Route) -> None:
        request = route.request
        if request.url.endswith("/steps"):
            body = json.loads(request.post_data or "{}")
            session_id = request.url.split("/sessions/")[1].split("/steps")[0]
            plan = {**DEFAULT_PLAN, "step_id": body.get("step_id", "s-1")}
            self.captured_steps.append(CapturedStep(session_id=session_id, request_body=body, response_plan=plan))
            route.fulfill(status=200, content_type="application/json", body=json.dumps(plan))
        elif request.method == "POST":
            session_id = str(uuid.uuid4())
            route.fulfill(
                status=201,
                content_type="application/json",
                body=json.dumps({"session_id": session_id, "model": "mock", "limits": {"max_steps": 30, "max_image_px": 1_600_000}}),
            )
        else:  # DELETE /v1/sessions/{id}
            route.fulfill(status=204)

    def install(self, context: BrowserContext) -> None:
        # One glob broad enough to catch open (POST /v1/sessions), step (POST .../steps) and close
        # (DELETE /v1/sessions/{id}) — dispatched by URL/method inside `_handle` instead of relying
        # on Playwright's route-registration-order precedence across several overlapping globs.
        context.route("**/v1/sessions**", self._handle)

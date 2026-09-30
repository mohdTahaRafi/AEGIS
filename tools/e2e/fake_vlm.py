"""DEBUGGING STUB ONLY, never an acceptance run. An OpenAI-compatible /v1/chat/completions that
reads the gateway's real prompt for demo/signin.html and answers the plan a correct model would, so
the extension and gateway can be exercised end to end without spending the VLM's daily quota.

    python3 tools/e2e/fake_vlm.py            # :8799
    AEGIS_MODEL_URL=http://127.0.0.1:8799/v1 AEGIS_MODEL_API_KEY=unused server/deploy/run-gateway.sh

It records whether the request carried an image, and never logs prompt text.
"""

from __future__ import annotations

import json
import os
import re
from http.server import BaseHTTPRequestHandler, HTTPServer

# one_shot: type+click+done in one plan. two_step: type, then click+done on step 2 (exercises the
# full-snapshot step 2). click_point: type, then click_point on the button from the image.
# probe: always done (for tools/e2e/probe_site.py on arbitrary sites).
SCENARIO = os.environ.get("FAKE_VLM_SCENARIO", "one_shot")

ELEMENT = re.compile(r"^(n-[0-9a-z]+|e[0-9]+) \| (\w+) \| \"([^\"]*)\"", re.M)
USERNAME_REF = re.compile(r"⟪(USERNAME#\d+)⟫")
VIEWPORT = re.compile(r"^VIEWPORT: ([\d.]+)x([\d.]+)", re.M)


def point_on(user_text: str, node: str, label: str) -> dict:
    """A click_point at `node`'s centre in the model's convention (rel1000_long_side: 0-1000 along
    the image's long side; the image is the viewport times `scale`, so the scale cancels)."""
    box = re.search(rf"^{node} \| \w+ \| \"[^\"]*\" \| \[([\d.-]+),([\d.-]+),([\d.-]+),([\d.-]+)\]", user_text, re.M)
    x, y, w, h = (float(v) for v in box.groups())
    vw, vh = (float(v) for v in VIEWPORT.search(user_text).groups())
    unit = max(vw, vh) / 1000
    return {"op": "click_point", "x": round((x + w / 2) / unit), "y": round((y + h / 2) / unit), "label": label}


def plan_for(user_text: str) -> dict:
    if SCENARIO == "probe":  # any page: complete the round trip, act on nothing
        return {"actions": [{"op": "done", "summary": "probe"}]}
    if SCENARIO == "type_task_text":  # "Type X into ...": type X into the first textbox, done next step
        if re.search(r"^HISTORY: s-\d+:", user_text, re.M):
            return {"actions": [{"op": "done", "summary": "typed"}]}
        text = re.search(r"^TASK: Type (\S+) into", user_text, re.M)
        box = next((i for i, role, _ in ELEMENT.findall(user_text) if role == "textbox"), None)
        if not (text and box):
            return {"actions": [{"op": "stop", "reason": "cannot_proceed", "detail": "fake: no textbox"}]}
        return {"actions": [{"op": "type", "node": box, "text": text.group(1)}]}
    if SCENARIO == "type_target":  # 'Type "X" into ...': type X into the element named FAKE_VLM_TARGET
        if re.search(r"^HISTORY: s-\d+:", user_text, re.M):
            return {"actions": [{"op": "done", "summary": "typed"}]}
        text = re.search(r'^TASK: Type "([^"]+)" into', user_text, re.M)
        wanted = os.environ.get("FAKE_VLM_TARGET", "Message Body")
        box = next((i for i, _, name in ELEMENT.findall(user_text) if name == wanted), None)
        if not (text and box):
            return {"actions": [{"op": "stop", "reason": "cannot_proceed", "detail": "fake: target not found"}]}
        return {"actions": [{"op": "type", "node": box, "text": text.group(1)}]}
    if SCENARIO == "open_link":  # click the link named FAKE_VLM_TARGET, then report the page it lands on
        if re.search(r"^HISTORY: s-\d+:", user_text, re.M):
            heading = next((name for _, role, name in ELEMENT.findall(user_text) if role == "heading"), "?")
            return {"actions": [{"op": "done", "summary": f"now on: {heading}"[:120]}]}
        wanted = os.environ.get("FAKE_VLM_TARGET", "")
        link = next((i for i, role, name in ELEMENT.findall(user_text) if role == "link" and name == wanted), None)
        if not link:
            return {"actions": [{"op": "stop", "reason": "cannot_proceed", "detail": "fake: link not found"}]}
        return {"actions": [{"op": "click", "node": link}]}
    if SCENARIO == "wrong_site":  # open FAKE_VLM_URL in a new tab, hover + Enter on its button, done
        elements = ELEMENT.findall(user_text)
        history = len(re.findall(r"^(?:HISTORY: )?s-\d+: ", user_text, re.M))
        if history == 0:
            return {"actions": [{"op": "open_tab", "url": os.environ.get("FAKE_VLM_URL", "")}]}
        button = next((i for i, role, _ in elements if role == "button"), None)
        if history == 1 and button:
            return {"actions": [{"op": "hover", "node": button}, {"op": "press_key", "key": "Enter", "node": button}]}
        heading = next((name for _, role, name in elements if role == "heading"), "?")
        return {"actions": [{"op": "done", "summary": f"now on: {heading}"[:120]}]}
    if SCENARIO == "search":  # any search page: type a query, submit, finish on the next page
        if re.search(r"^HISTORY: s-\d+:", user_text, re.M):
            return {"actions": [{"op": "done", "summary": "searched"}]}
        rows = ELEMENT.findall(user_text)
        box = next((i for i, role, _ in rows if role in ("searchbox", "textbox", "combobox")), None)
        button = next((i for i, role, _ in rows if role == "button"), None)
        if not (box and button):
            return {"actions": [{"op": "stop", "reason": "cannot_proceed"}]}
        return {"actions": [{"op": "type", "node": box, "text": "ISRO launches"}, {"op": "click", "node": button}]}
    elements = ELEMENT.findall(user_text)
    textbox = next((i for i, role, name in elements if role == "textbox" and name == "Username"), None)
    button = next((i for i, role, name in elements if role == "button" and name == "Sign in"), None)
    ref = USERNAME_REF.search(user_text)
    if "type ->" in user_text and button:  # already typed in an earlier step
        if SCENARIO == "click_point":
            return {"actions": [point_on(user_text, button, "Sign in"), {"op": "done", "summary": "Signed in."}]}
        return {"actions": [{"op": "click", "node": button}, {"op": "done", "summary": "Signed in."}]}
    if not (textbox and button and ref):
        return {"actions": [{"op": "stop", "reason": "cannot_proceed"}]}
    if SCENARIO == "click_point":  # two different targets, both by coordinates
        return {"actions": [point_on(user_text, textbox, "Username"), {"op": "type", "node": textbox, "ref": ref.group(1)}]}
    if SCENARIO == "two_step":
        return {"actions": [{"op": "type", "node": textbox, "ref": ref.group(1)}]}
    return {
        "actions": [
            {"op": "type", "node": textbox, "ref": ref.group(1)},
            {"op": "click", "node": button},
            {"op": "done", "summary": "Entered the registered username and clicked Sign in."},
        ]
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # /v1/models for readyz
        self._send({"data": [{"id": "fake"}]})

    def do_POST(self) -> None:
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        user = next(m for m in body["messages"] if m["role"] == "user")["content"]
        has_image = isinstance(user, list) and any(p.get("type") == "image_url" for p in user)
        text = user if isinstance(user, str) else next(p["text"] for p in user if p.get("type") == "text")
        try:
            plan = plan_for(text)
        except Exception as exc:  # a stub bug must not look like an unreachable model
            print(json.dumps({"fake_vlm_error": repr(exc), "head": text[:160]}), flush=True)
            plan = {"actions": [{"op": "stop", "reason": "cannot_proceed", "detail": "fake_vlm error"}]}
        print(json.dumps({"fake_vlm": True, "image": has_image, "ops": [a["op"] for a in plan["actions"]]}), flush=True)
        self._send({"choices": [{"message": {"role": "assistant", "content": json.dumps(plan)}}], "usage": {"prompt_tokens": 0, "completion_tokens": 0}})

    def _send(self, payload: dict) -> None:
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args: object) -> None:
        pass


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", 8799), Handler).serve_forever()

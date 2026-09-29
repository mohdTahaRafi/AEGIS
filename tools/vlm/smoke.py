"""R-1 (docs/planning/bugs/R-1-vlm-endpoint.md) — smoke test and latency probe for the server VLM.

Talks to any OpenAI-compatible `/chat/completions` endpoint. The default target (R-1 decision) is
`qwen/qwen3.8-27b` on Groq's free tier (`https://api.groq.com/openai/v1`), with thinking switched
off by `reasoning_effort: "none"` on every call (`--extra-body`). It answers the questions
R-2/R-3/R-12 need settled before they start, by measurement, not assumption:

  text        does a minimal authenticated call work at all? (aborts the run if not)
  vision      does the model actually read the image? (a random code word only visible in pixels)
  grounding   what coordinate convention do its points come back in? (raw values, recorded only)
  kwargs      which switch (the gateway's `chat_template_kwargs`, OpenRouter's `reasoning`, Groq's
              `reasoning_effort`) is accepted and actually turns thinking off? Observed from the
              reasoning text returned, not just HTTP 200. Sent without `--extra-body`
  structured  does it accept `response_format` json_schema / json_object, obey it, and is the
              schema actually enforced (a required key the prompt never mentions)?
  gateway     is the exact request body the gateway sends today (the real action-plan schema,
              strict, plus `chat_template_kwargs`) accepted, and which part is rejected if not?
  latency     TTFT and total time for the real system prompt + a ~1.2k-token step + one
              1280x720 WebP, streamed, N runs after one warm-up

Every call records the serving provider and how much reasoning ("thinking") text came back, since
a hybrid-thinking model spends time and tokens there before any content. The last rate-limit
headers the endpoint sent (`x-ratelimit-*`) are recorded too.

Every image and value here is synthetic, drawn by this script. The API key is read from
AEGIS_MODEL_API_KEY, GROQ_API_KEY or OPENROUTER_API_KEY and is never printed or written to the
report.

    export GROQ_API_KEY=...
    python3 tools/vlm/smoke.py --runs 10 --json-out tools/vlm/reports/r1-<date>-groq.json

Needs Python >= 3.12 and Pillow (stdlib otherwise, so it runs outside the gateway venv).
"""

from __future__ import annotations

import argparse
import base64
import http.client
import io
import json
import os
import platform
import random
import re
import statistics
import string
import sys
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "server" / "gateway" / "src"))
from aegis_gateway.prompt import SYSTEM_PROMPT, build_user_message  # noqa: E402

DEFAULT_BASE_URL = "https://api.groq.com/openai/v1"
DEFAULT_MODEL = "qwen/qwen3.8-27b"
# Groq's thinking switch for Qwen (docs: console.groq.com/docs/reasoning). Merged into every call
# except the `kwargs` probe, which compares the switches on their own.
GROQ_EXTRA_BODY = {"reasoning_effort": "none"}
VIEWPORT = (1280, 720)
BUTTON_BOX = (880, 420, 1120, 500)  # x0, y0, x1, y1 in image pixels; deliberately unlabelled
SCHEMA_DIR = REPO / "packages" / "protocol" / "schema"
RATE_LIMIT_HEADERS = (
    "retry-after",
    "x-ratelimit-limit-requests",
    "x-ratelimit-limit-tokens",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-tokens",
)


def _api_key() -> str | None:
    return (
        os.environ.get("AEGIS_MODEL_API_KEY")
        or os.environ.get("GROQ_API_KEY")
        or os.environ.get("OPENROUTER_API_KEY")
    )


def _is_local(base_url: str) -> bool:
    return any(h in base_url for h in ("://localhost", "://127.0.0.1", "://[::1]"))


def _font(size: int) -> ImageFont.ImageFont:
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1
        return ImageFont.load_default()


def make_fixture_image(code_word: str) -> bytes:
    """A synthetic form page: grey (unanalysed) strip, a black redaction box, a red banner
    carrying `code_word`, and a green button with no text below the banner."""
    img = Image.new("RGB", VIEWPORT, "white")
    d = ImageDraw.Draw(img)
    d.rectangle((0, 0, 1280, 64), fill="#1f2937")
    d.text((24, 18), "Citizen Services Portal", fill="white", font=_font(26))
    d.rectangle((0, 64, 220, 720), fill="#9ca3af")  # "not analysed" grey, as the compositor draws
    d.rectangle((260, 100, 1240, 190), fill="#dc2626")
    d.text((290, 118), code_word, fill="white", font=_font(52))
    for i, label in enumerate(("Full name", "Mobile number", "Aadhaar number")):
        y = 230 + i * 90
        d.text((260, y), label, fill="#111827", font=_font(22))
        d.rectangle((260, y + 30, 760, y + 70), outline="#6b7280", width=2)
    d.rectangle((264, 444, 520, 476), fill="black")  # redacted value in the Aadhaar field
    d.text((272, 450), "AADHAAR#1", fill="white", font=_font(18))  # default font lacks ⟪⟫
    d.rounded_rectangle(BUTTON_BOX, radius=10, fill="#16a34a")
    return _encode(img)


# The extension always sends WebP at quality 0.8 (perception/compose/compositor.ts:encodeWebp);
# PNG exists only to test whether lossy compression explains a misread (`--image-format png`).
IMAGE_FORMATS = {"webp": ("WEBP", "image/webp", {"quality": 80}), "png": ("PNG", "image/png", {})}
image_format = "webp"


def _encode(img: Image.Image) -> bytes:
    pil_format, _, options = IMAGE_FORMATS[image_format]
    buf = io.BytesIO()
    img.save(buf, pil_format, **options)
    return buf.getvalue()


def synthetic_step_request(n_nodes: int = 20) -> dict:
    """A step shaped like the extension's, so the text block has the real format and size."""
    roles = ("textbox", "button", "link", "checkbox", "combobox")
    nodes = []
    for i in range(n_nodes):
        role = roles[i % len(roles)]
        nodes.append(
            {
                "id": f"n-{0x40 + i:x}",
                "role": role,
                "name": f"{role.title()} {i} for the application form section {i // 6}",
                "box": [260 + (i % 3) * 300, 100 + i * 17, 280, 36],
                "state": {"required": i % 4 == 0, "has_value": False} if role == "textbox" else {},
            }
        )
    return {
        "task": "Fill the application form with my details and submit it.",
        "history": [
            {"step_id": "s-1", "actions": [{"op": "click"}], "outcome": "ok"},
            {"step_id": "s-2", "actions": [{"op": "type"}, {"op": "type"}], "outcome": "ok"},
        ],
        "viewport": {"w": VIEWPORT[0], "h": VIEWPORT[1], "scroll_y": 0},
        "redactions": [{"ref": "⟪AADHAAR#1⟫", "entity": "AADHAAR", "class": "CRITICAL"}],
        "nodes": nodes,
        "text": [
            {"id": f"t-{i}", "text": f"Section {i} instructions for applicants."} for i in range(8)
        ],
    }


def _image_part(webp: bytes) -> dict:
    mime = IMAGE_FORMATS[image_format][1]
    url = f"data:{mime};base64," + base64.b64encode(webp).decode("ascii")
    return {"type": "image_url", "image_url": {"url": url}}


# A tokens-per-minute 429 asks for at most 60 s; anything longer is a per-day limit.
MAX_RETRY_WAIT_S = 120.0

# A dropped connection or timeout is a failed sample (status 0), counted like any other failure.
# It must never abort the run and lose every measurement made before it (seen live 2026-09-28:
# Groq closed one streamed connection without a response mid-latency-run).
NETWORK_ERRORS = (urllib.error.URLError, http.client.HTTPException, OSError)


def _network_error(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {exc}"[:400]


class Endpoint:
    def __init__(
        self,
        base_url: str,
        model: str,
        key: str | None,
        timeout: float,
        max_retries: int = 0,
        retry_wait_s: float = 15.0,
        extra_body: dict | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self._key = key
        self.timeout = timeout
        self.max_retries = max_retries
        self.retry_wait_s = retry_wait_s
        self.extra_body = extra_body or {}
        self.rate_limited_total = 0
        self.last_retries = 0
        self.served_models: set[str] = set()
        self.served_providers: set[str] = set()
        self.rate_limit_headers: dict[str, str] = {}
        self._retry_after_s: float | None = None

    def _headers(self, headers) -> None:
        """Keep the last rate-limit headers seen, and `retry-after` for the next 429 wait."""
        seen = {h: headers[h] for h in RATE_LIMIT_HEADERS if headers.get(h) is not None}
        if seen:
            self.rate_limit_headers = seen
        try:
            self._retry_after_s = float(headers.get("retry-after"))
        except (TypeError, ValueError):
            self._retry_after_s = None

    def _note(self, obj: dict) -> None:
        if obj.get("model"):
            self.served_models.add(obj["model"])
        if obj.get("provider"):  # OpenRouter names the upstream provider in the body
            self.served_providers.add(obj["provider"])

    def _request(self, payload: dict, use_extra: bool = True) -> urllib.request.Request:
        # An explicit UA: urllib's default `Python-urllib/3.x` is blocked by some providers' WAFs
        # (measured 2026-09-28 on the earlier HF/Featherless endpoint: 403 with it, 200 without).
        headers = {"Content-Type": "application/json", "User-Agent": "aegis-vlm-smoke/0.1"}
        if self._key:
            headers["Authorization"] = f"Bearer {self._key}"
        extra = self.extra_body if use_extra else {}
        body = json.dumps({"model": self.model, **extra, **payload}).encode()
        return urllib.request.Request(
            f"{self.base_url}/chat/completions", data=body, headers=headers, method="POST"
        )

    def _retry_429(self, call):
        """Shared free routes answer 429 when the upstream pool is saturated. Retrying is fair to
        the measurement only because each attempt is timed on its own (the clock starts inside
        `call`) and every rejection is counted into the report, never folded into a latency."""
        retries = 0
        while True:
            result = call()
            if result[0] != 429:
                return result, retries
            self.rate_limited_total += 1
            # Groq sends `retry-after` on 429; waiting less just earns another 429. A wait longer
            # than MAX_RETRY_WAIT_S is a daily (or other long-window) limit: give up, don't sleep.
            wait = max(self.retry_wait_s, self._retry_after_s or 0)
            if retries >= self.max_retries or wait > MAX_RETRY_WAIT_S:
                return result, retries
            retries += 1
            time.sleep(wait)

    def complete(self, payload: dict, use_extra: bool = True) -> tuple[int, dict | str, float]:
        """Non-streamed call. Returns (status, parsed body or error text, seconds)."""
        (status, body, secs), self.last_retries = self._retry_429(
            lambda: self._complete(payload, use_extra)
        )
        return status, body, secs

    def _complete(self, payload: dict, use_extra: bool) -> tuple[int, dict | str, float]:
        t0 = time.perf_counter()
        try:
            req = self._request(payload, use_extra)
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                self._headers(resp.headers)
                body = json.loads(resp.read())
                self._note(body)
                if "error" in body and "choices" not in body:  # OpenRouter: HTTP 200 + error
                    return 502, json.dumps(body["error"])[:400], time.perf_counter() - t0
                return resp.status, body, time.perf_counter() - t0
        except urllib.error.HTTPError as exc:
            self._headers(exc.headers)
            return exc.code, exc.read().decode(errors="replace")[:400], time.perf_counter() - t0
        except NETWORK_ERRORS as exc:
            return 0, _network_error(exc), time.perf_counter() - t0

    def stream(self, payload: dict) -> dict:
        """Streamed call. TTFT is the arrival of the first non-empty content delta."""
        (_, result), retries = self._retry_429(
            lambda: (lambda r: (r.get("status", 200), r))(self._stream(payload))
        )
        return result | {"retries_429": retries}

    def _stream(self, payload: dict) -> dict:
        payload = {**payload, "stream": True, "stream_options": {"include_usage": True}}
        t0 = time.perf_counter()
        ttft = None
        text: list[str] = []
        reasoning_chars = 0
        usage = None
        try:
            with urllib.request.urlopen(self._request(payload), timeout=self.timeout) as resp:
                self._headers(resp.headers)
                for raw in resp:
                    line = raw.decode().strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    chunk = json.loads(data)
                    self._note(chunk)
                    if "error" in chunk:  # mid-stream failure after HTTP 200
                        err = json.dumps(chunk["error"])[:400]
                        return {"ok": False, "status": 200, "error": err}
                    # Groq puts the final usage under `x_groq`, OpenAI-style servers at the top.
                    usage = chunk.get("usage") or (chunk.get("x_groq") or {}).get("usage") or usage
                    for choice in chunk.get("choices", []):
                        reasoning_chars += len((choice.get("delta") or {}).get("reasoning") or "")
                        delta = (choice.get("delta") or {}).get("content")
                        if delta:
                            if ttft is None:
                                ttft = time.perf_counter() - t0
                            text.append(delta)
        except urllib.error.HTTPError as exc:
            self._headers(exc.headers)
            return {
                "ok": False,
                "status": exc.code,
                "error": exc.read().decode(errors="replace")[:400],
            }
        except NETWORK_ERRORS as exc:
            return {"ok": False, "status": 0, "error": _network_error(exc)}
        total = time.perf_counter() - t0
        return {
            "ok": ttft is not None,
            "ttft_s": ttft,
            "total_s": total,
            "usage": usage,
            "chars": len("".join(text)),
            "reasoning_chars": reasoning_chars,
        }


def _content(body: dict | str) -> str:
    if isinstance(body, str):
        return ""
    return body["choices"][0]["message"].get("content") or ""


def _reasoning_chars(body: dict | str) -> int:
    """Reasoning in a separate field (`reasoning`, Groq's `parsed` format and OpenRouter), or
    inline as `<think>...</think>` in the content (Groq's `raw` format, vLLM without a parser)."""
    if isinstance(body, str):
        return 0
    message = body["choices"][0]["message"]
    inline = re.search(r"<think>(.*?)(</think>|$)", message.get("content") or "", re.S)
    return len(message.get("reasoning") or "") + (len(inline.group(1)) if inline else 0)


def _parse_json(text: str) -> object | None:
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`").removeprefix("json").strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def check_text(ep: Endpoint) -> dict:
    """The minimal authenticated call. Everything else is meaningless if this fails."""
    status, body, secs = ep.complete(
        {"messages": [{"role": "user", "content": "Reply with the word ok."}], "max_tokens": 5}
    )
    return {
        "status": status,
        "seconds": round(secs, 2),
        "answer": _content(body).strip()[:40] if status == 200 else body,
        "reasoning_chars": _reasoning_chars(body),
        "served_model": body.get("model") if isinstance(body, dict) else None,
        "served_provider": body.get("provider") if isinstance(body, dict) else None,
        "pass": status == 200 and bool(_content(body).strip()),
    }


def check_vision(ep: Endpoint, webp: bytes, code_word: str) -> dict:
    status, body, secs = ep.complete(
        {
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": (
                                "What word is written in white on the red banner? "
                                "Reply with that word only."
                            ),
                        },
                        _image_part(webp),
                    ],
                }
            ],
            "max_tokens": 20,
            "temperature": 0,
        }
    )
    answer = _content(body)
    norm = lambda s: "".join(c for c in s.upper() if c.isalnum())  # noqa: E731
    return {
        "status": status,
        "seconds": round(secs, 2),
        "expected": code_word,
        "answer": answer.strip()[:80] if status == 200 else body,
        "pass": status == 200 and norm(code_word) in norm(answer),
    }


def check_grounding(ep: Endpoint, webp: bytes) -> dict:
    status, body, secs = ep.complete(
        {
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": (
                                "There is one green button with no text on it. "
                                "Give the point at its "
                                'centre. Reply with JSON only: {"x": <number>, "y": <number>}.'
                            ),
                        },
                        _image_part(webp),
                    ],
                }
            ],
            "max_tokens": 40,
            "temperature": 0,
        }
    )
    point = _parse_json(_content(body)) if status == 200 else None
    x0, y0, x1, y1 = BUTTON_BOX
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    result: dict = {
        "status": status,
        "seconds": round(secs, 2),
        "raw": _content(body)[:120] if status == 200 else body,
        "truth_px": [cx, cy],
        "truth_rel1000": [round(cx / VIEWPORT[0] * 1000), round(cy / VIEWPORT[1] * 1000)],
    }
    if (
        isinstance(point, dict)
        and isinstance(point.get("x"), (int, float))
        and isinstance(point.get("y"), (int, float))
    ):
        x, y = float(point["x"]), float(point["y"])
        result["inside_if_px"] = x0 <= x <= x1 and y0 <= y <= y1
        result["inside_if_rel1000"] = (
            x0 <= x / 1000 * VIEWPORT[0] <= x1 and y0 <= y / 1000 * VIEWPORT[1] <= y1
        )
        # 0-1000 of the longer side on both axes, as if the image were padded to a square. Found
        # 2026-09-28 on Groq qwen/qwen3.8-27b, whose y matched neither convention above.
        side = max(VIEWPORT)
        result["inside_if_rel1000_long_side"] = (
            x0 <= x / 1000 * side <= x1 and y0 <= y / 1000 * side <= y1
        )
    return result


def _random_code_word() -> str:
    return "".join(random.choices(string.ascii_uppercase, k=5)) + "-" + str(random.randint(10, 99))


def run_trials(
    ep: Endpoint, trials: int, words: list[str] | None = None, with_grounding: bool = True
) -> dict:
    """Accuracy, not a single yes/no: `trials` vision (and grounding) calls, each on a freshly drawn
    image with a new code word (the button box is fixed). `words` replays given code words instead,
    e.g. earlier misreads: the drawing is deterministic, so the same word gives the same image."""
    vision, grounding = [], []
    for word in words or [_random_code_word() for _ in range(trials)]:
        webp = make_fixture_image(word)
        vision.append(check_vision(ep, webp, word))
        if with_grounding:
            grounding.append(check_grounding(ep, webp))
    ok_g = [g for g in grounding if g["status"] == 200]
    return {
        "n": len(vision),
        "vision": {
            "n_ok": sum(v["status"] == 200 for v in vision),
            "n_pass": sum(v["pass"] for v in vision),
            "answers": [
                {"expected": v["expected"], "answer": v["answer"], "pass": v["pass"]}
                for v in vision
            ],
            "seconds": [v["seconds"] for v in vision],
        },
        "grounding": {
            "n_ok": len(ok_g),
            "n_parsed": sum("inside_if_px" in g for g in ok_g),
            "n_inside_if_px": sum(bool(g.get("inside_if_px")) for g in ok_g),
            "n_inside_if_rel1000": sum(bool(g.get("inside_if_rel1000")) for g in ok_g),
            "n_inside_if_rel1000_long_side": sum(
                bool(g.get("inside_if_rel1000_long_side")) for g in ok_g
            ),
            "raw": [g["raw"] for g in grounding],
            "seconds": [g["seconds"] for g in grounding],
        },
    }


# Unlabelled targets at fixed fractions of the canvas, so the same layout is drawn landscape and
# portrait. Distinct colour + shape, so each can be named without text on the image.
GRID_TARGETS = (
    ("red circle", "#dc2626", "circle", (0.15, 0.22)),
    ("blue square", "#2563eb", "square", (0.82, 0.18)),
    ("purple circle", "#7c3aed", "circle", (0.30, 0.78)),
    ("orange square", "#ea580c", "square", (0.72, 0.62)),
)
GRID_HALF = 40  # half the target's side / its radius, in image pixels
# (drawn size, pad to a square?) `portrait_padded` is the portrait page placed at the top left of
# a square canvas filled with the compositor's "not analysed" grey: a candidate R-12 fix.
GRID_CANVASES = {
    "landscape": ((1280, 720), False),
    "portrait": ((720, 1280), False),
    "portrait_padded": ((720, 1280), True),
}


def make_grid_image(
    size: tuple[int, int], pad_square: bool = False
) -> tuple[bytes, dict[str, tuple[float, float]]]:
    """A page-like canvas (dark header, grey side strip) with the GRID_TARGETS drawn, no text.
    Returns the encoded image and each target's centre in image pixels (padding is added right
    or below, so centres don't move)."""
    w, h = size
    img = Image.new("RGB", size, "white")
    d = ImageDraw.Draw(img)
    d.rectangle((0, 0, w, 56), fill="#1f2937")
    d.rectangle((0, 56, 36, h), fill="#9ca3af")
    centres = {}
    for name, colour, shape, (fx, fy) in GRID_TARGETS:
        cx, cy = round(fx * w), round(fy * h)
        box = (cx - GRID_HALF, cy - GRID_HALF, cx + GRID_HALF, cy + GRID_HALF)
        (d.ellipse if shape == "circle" else d.rectangle)(box, fill=colour)
        centres[name] = (cx, cy)
    if pad_square:
        square = Image.new("RGB", (max(size), max(size)), "#9ca3af")
        square.paste(img, (0, 0))
        img = square
    return _encode(img), centres


def _grid_hypotheses(x: float, y: float, w: int, h: int) -> dict[str, tuple[float, float]]:
    """A model point mapped to image pixels under each candidate convention (R-12)."""
    side = max(w, h)
    return {
        "px": (x, y),
        "rel1000": (x / 1000 * w, y / 1000 * h),
        "rel1000_long_side": (x / 1000 * side, y / 1000 * side),
    }


def _fit(model: list[float], truth: list[float]) -> dict | None:
    """Least squares truth = a·model + b. `a·1000` is the image length the model's 0–1000 scale
    spans on that axis (≈ w or h for per-axis rel1000, ≈ the longer side for long-side)."""
    if len(model) < 2 or len(set(model)) < 2:
        return None
    mx, mt = statistics.mean(model), statistics.mean(truth)
    a = sum((m - mx) * (t - mt) for m, t in zip(model, truth, strict=True)) / sum(
        (m - mx) ** 2 for m in model
    )
    b = mt - a * mx
    residual = max(abs(a * m + b - t) for m, t in zip(model, truth, strict=True))
    return {
        "a": round(a, 4),
        "b": round(b, 1),
        "a_x1000": round(a * 1000),
        "max_residual_px": round(residual, 1),
    }


def run_grounding_grid(ep: Endpoint, canvases: list[str]) -> dict:
    """R-12 input: one call per target, on a landscape and a portrait canvas. Each answer is
    scored under every convention in `_grid_hypotheses` (inside the target or not, and the error
    in pixels), and a per-axis linear fit shows what scale the model actually uses."""
    result: dict = {}
    for orientation in canvases:
        drawn, pad = GRID_CANVASES[orientation]
        image, centres = make_grid_image(drawn, pad)
        w, h = (max(drawn), max(drawn)) if pad else drawn
        answers = []
        for name, (cx, cy) in centres.items():
            status, body, secs = ep.complete(
                {
                    "messages": [
                        {
                            "role": "user",
                            "content": [
                                {
                                    "type": "text",
                                    "text": (
                                        f"There is one {name} with no text on it. Give the point "
                                        'at its centre. Reply with JSON only: {"x": <number>, '
                                        '"y": <number>}.'
                                    ),
                                },
                                _image_part(image),
                            ],
                        }
                    ],
                    "max_tokens": 40,
                    "temperature": 0,
                }
            )
            point = _parse_json(_content(body)) if status == 200 else None
            entry: dict = {
                "target": name,
                "truth_px": [cx, cy],
                "status": status,
                "seconds": round(secs, 2),
                "raw": _content(body)[:120] if status == 200 else body,
            }
            if (
                isinstance(point, dict)
                and isinstance(point.get("x"), (int, float))
                and isinstance(point.get("y"), (int, float))
            ):
                x, y = float(point["x"]), float(point["y"])
                entry["model_xy"] = [x, y]
                entry["inside"], entry["err_px"] = {}, {}
                for hyp, (px, py) in _grid_hypotheses(x, y, w, h).items():
                    entry["inside"][hyp] = abs(px - cx) <= GRID_HALF and abs(py - cy) <= GRID_HALF
                    entry["err_px"][hyp] = round(((px - cx) ** 2 + (py - cy) ** 2) ** 0.5, 1)
            answers.append(entry)
        parsed = [a for a in answers if "model_xy" in a]
        hyps = ("px", "rel1000", "rel1000_long_side")
        result[orientation] = {
            "size": [w, h],
            "drawn_size": list(drawn),
            "n": len(answers),
            "n_parsed": len(parsed),
            "n_inside": {k: sum(a["inside"][k] for a in parsed) for k in hyps},
            "fit": {
                "x": _fit([a["model_xy"][0] for a in parsed], [a["truth_px"][0] for a in parsed]),
                "y": _fit([a["model_xy"][1] for a in parsed], [a["truth_px"][1] for a in parsed]),
            },
            "answers": answers,
        }
    return result


def check_kwargs(ep: Endpoint) -> dict:
    """`chat_template_kwargs` is what the gateway sends on every request (model_client/
    adapters.py, vLLM's form); `reasoning` is OpenRouter's own switch; `reasoning_effort` is Groq's.
    `none` is the baseline with no switch at all. HTTP 200 alone only shows the parameter was
    tolerated (OpenRouter drops unsupported ones silently), so each result also records whether
    reasoning text still came back: `thinking_off` is the observable outcome. `--extra-body` is not
    sent here, so each switch is judged on its own."""
    results = {}
    for name, extra in {
        "none": {},
        "chat_template_kwargs": {"chat_template_kwargs": {"enable_thinking": False}},
        "openrouter_reasoning": {"reasoning": {"enabled": False}},
        "groq_reasoning_effort": {"reasoning_effort": "none"},
    }.items():
        status, body, secs = ep.complete(
            {"messages": [{"role": "user", "content": "Reply with the word ok."}], "max_tokens": 64}
            | extra,
            use_extra=False,
        )
        results[name] = {
            "status": status,
            "seconds": round(secs, 2),
            "accepted": status == 200,
            "answer": _content(body).strip()[:40] if status == 200 else None,
            "reasoning_chars": _reasoning_chars(body),
            "completion_tokens": (body.get("usage") or {}).get("completion_tokens")
            if isinstance(body, dict)
            else None,
            "thinking_off": status == 200 and _reasoning_chars(body) == 0,
            "error": None if status == 200 else body,
        }
    return results


STRUCTURED_SCHEMA = {
    "type": "object",
    "properties": {
        "step_id": {"type": "string", "pattern": "^s-[0-9]+$"},
        "actions": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "properties": {
                    "op": {"type": "string", "enum": ["click", "done"]},
                    "node": {"type": "string"},
                },
                "required": ["op"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["step_id", "actions"],
    "additionalProperties": False,
}


def check_structured(ep: Endpoint) -> dict:
    prompt = (
        'Step s-3. The page has one button, id n-81, "Submit". Plan the step: click it, then done.'
    )
    results = {}
    formats = {
        "json_schema": {
            "type": "json_schema",
            "json_schema": {"name": "plan", "schema": STRUCTURED_SCHEMA, "strict": True},
        },
        "json_object": {"type": "json_object"},
    }
    for name, fmt in formats.items():
        status, body, secs = ep.complete(
            {
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            'Output only JSON: {"step_id": ..., '
                            '"actions": [{"op": ..., "node": ...}]}.'
                        ),
                    },
                    {"role": "user", "content": prompt},
                ],
                "response_format": fmt,
                "max_tokens": 120,
                "temperature": 0,
            }
        )
        parsed = _parse_json(_content(body)) if status == 200 else None
        shape_ok = (
            isinstance(parsed, dict)
            and set(parsed) == {"step_id", "actions"}
            and isinstance(parsed["actions"], list)
            and bool(parsed["actions"])
        )
        results[name] = {
            "status": status,
            "seconds": round(secs, 2),
            "parsed": parsed is not None,
            "shape_ok": shape_ok,
            "raw": _content(body)[:200] if status == 200 else body,
        }
    results["json_schema_enforced"] = _check_schema_enforced(ep)
    return results


ENFORCEMENT_SCHEMA = {
    "type": "object",
    "properties": {
        "verdict": {"type": "string", "enum": ["proceed", "halt"]},
        "target": {"type": "string", "pattern": "^n-[0-9a-f]+$"},
    },
    "required": ["verdict", "target"],
    "additionalProperties": False,
}


def _check_schema_enforced(ep: Endpoint) -> dict:
    """Following a schema the prompt also spells out proves nothing about enforcement. Here the
    prompt never names the keys: output with exactly `verdict` + `target` means the schema reached
    the decoder (or at least the model); anything else means it was ignored."""
    status, body, secs = ep.complete(
        {
            "messages": [
                {"role": "user", "content": "The page has one button, id n-81. Should we click it?"}
            ],
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "verdict", "schema": ENFORCEMENT_SCHEMA, "strict": True},
            },
            "max_tokens": 60,
            "temperature": 0,
        }
    )
    parsed = _parse_json(_content(body)) if status == 200 else None
    conforms = (
        isinstance(parsed, dict)
        and set(parsed) == {"verdict", "target"}
        and parsed["verdict"] in ("proceed", "halt")
        and isinstance(parsed["target"], str)
        and re.fullmatch(r"n-[0-9a-f]+", parsed["target"]) is not None
    )
    return {
        "status": status,
        "seconds": round(secs, 2),
        "conforms": conforms,
        "raw": _content(body)[:200] if status == 200 else body,
    }


def load_gateway_schema() -> dict:
    """The action-plan schema exactly as the gateway sends it (model_client/vllm.py
    `load_action_plan_schema`: `common.schema.json` refs inlined). Re-done here because importing
    vllm.py needs httpx, and this script runs on the system Python."""
    common = json.loads((SCHEMA_DIR / "common.schema.json").read_text())["$defs"]

    def inline(node: object) -> object:
        if isinstance(node, dict):
            ref = node.get("$ref")
            if isinstance(ref, str) and ref.startswith("common.schema.json#/$defs/"):
                return inline(common[ref.split("/")[-1]])
            return {k: inline(v) for k, v in node.items()}
        if isinstance(node, list):
            return [inline(v) for v in node]
        return node

    return inline(json.loads((SCHEMA_DIR / "action-plan.schema.json").read_text()))


def check_gateway_request(ep: Endpoint) -> dict:
    """The gateway's own request shape today (VLLMClient.complete): the real action-plan schema
    with `strict: true`, plus `chat_template_kwargs`. Then each part varied on its own, so a
    rejection names its cause. `--extra-body` is sent, so thinking stays off."""
    schema = load_gateway_schema()
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": build_user_message(synthetic_step_request())},
    ]
    template_kwargs = {"chat_template_kwargs": {"enable_thinking": False}}
    variants = {
        "as_sent_today": ({"strict": True}, template_kwargs),
        "strict_without_template_kwargs": ({"strict": True}, {}),
        "best_effort_without_template_kwargs": ({"strict": False}, {}),
    }
    results = {}
    for name, (strict, extra) in variants.items():
        fmt = {"type": "json_schema", "json_schema": {"name": "action_plan", "schema": schema}}
        fmt["json_schema"] |= strict
        status, body, secs = ep.complete(
            {"messages": messages, "response_format": fmt, "max_tokens": 256, "temperature": 0}
            | extra
        )
        parsed = _parse_json(_content(body)) if status == 200 else None
        results[name] = {
            "status": status,
            "seconds": round(secs, 2),
            "parsed": parsed is not None,
            "has_step_id_and_actions": isinstance(parsed, dict)
            and {"step_id", "actions"} <= set(parsed),
            "raw": _content(body)[:300] if status == 200 else body,
        }
    return results


def _pct(values: list[float], p: float) -> float:
    ordered = sorted(values)
    k = max(0, min(len(ordered) - 1, round(p / 100 * len(ordered) + 0.5) - 1))  # nearest rank
    return ordered[k]


def run_latency(ep: Endpoint, webp: bytes, runs: int, max_tokens: int) -> dict:
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": build_user_message(synthetic_step_request())},
                _image_part(webp),
            ],
        },
    ]
    payload = {"messages": messages, "max_tokens": max_tokens, "temperature": 0}
    warmup = ep.stream(payload)
    samples = [ep.stream(payload) for _ in range(runs)]
    ok = [s for s in samples if s["ok"] and s["ttft_s"] is not None]
    summary: dict = {"warmup": warmup, "runs": samples, "n_ok": len(ok), "n": runs}
    if ok:
        ttft = [s["ttft_s"] for s in ok]
        total = [s["total_s"] for s in ok]
        summary["ttft_s"] = {
            "p50": _pct(ttft, 50),
            "p95": _pct(ttft, 95),
            "min": min(ttft),
            "max": max(ttft),
        }
        summary["total_s"] = {
            "p50": _pct(total, 50),
            "p95": _pct(total, 95),
            "min": min(total),
            "max": max(total),
        }
        summary["mean_total_s"] = statistics.mean(total)
    return summary


def _write(report: dict, path: Path | None) -> None:
    if path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(report, indent=2, ensure_ascii=False, default=str))
        print(f"report written to {path}")


def main() -> int:
    global image_format, MAX_RETRY_WAIT_S
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--base-url", default=os.environ.get("AEGIS_MODEL_URL", DEFAULT_BASE_URL))
    ap.add_argument("--model", default=os.environ.get("AEGIS_MODEL_NAME", DEFAULT_MODEL))
    ap.add_argument("--runs", type=int, default=5, help="measured latency runs after one warm-up")
    ap.add_argument(
        "--trials",
        type=int,
        default=0,
        help="extra vision + grounding calls on fresh images, reported as rates (0 = none)",
    )
    ap.add_argument("--max-tokens", type=int, default=256, help="completion budget per latency run")
    ap.add_argument("--timeout", type=float, default=180.0)
    ap.add_argument(
        "--max-retries", type=int, default=6, help="retries per call on HTTP 429 (0 = none)"
    )
    ap.add_argument(
        "--retry-wait",
        type=float,
        default=15.0,
        help="minimum seconds between 429 retries (a longer retry-after header wins)",
    )
    ap.add_argument(
        "--grounding-grid",
        action="store_true",
        help="R-12 input: 4 unlabelled targets on a landscape and a portrait image (8 calls)",
    )
    ap.add_argument(
        "--grid-canvases",
        nargs="+",
        choices=list(GRID_CANVASES),
        default=["landscape", "portrait"],
        help="which canvases --grounding-grid draws (4 calls each)",
    )
    ap.add_argument(
        "--trial-words",
        nargs="+",
        help="replay these code words in the trials instead of random ones",
    )
    ap.add_argument(
        "--max-retry-wait",
        type=float,
        default=MAX_RETRY_WAIT_S,
        help="longest retry-after (s) worth waiting for; raise it to wait out a daily limit",
    )
    ap.add_argument(
        "--image-format",
        choices=sorted(IMAGE_FORMATS),
        default="webp",
        help="webp (what the extension sends) or png (to test compression)",
    )
    ap.add_argument(
        "--extra-body",
        type=json.loads,
        default=None,
        help="JSON merged into every request except the kwargs probe; default "
        '\'{"reasoning_effort": "none"}\' for api.groq.com, else {}',
    )
    ap.add_argument(
        "--skip",
        nargs="*",
        default=[],
        choices=[
            "vision",
            "grounding",
            "trials",
            "grounding_grid",
            "kwargs",
            "structured",
            "gateway",
            "latency",
        ],
        help="the text check always runs: it gates everything else",
    )
    ap.add_argument(
        "--json-out", type=Path, help="write the full report here (no key, no image bytes)"
    )
    args = ap.parse_args()

    image_format = args.image_format
    MAX_RETRY_WAIT_S = args.max_retry_wait

    key = _api_key()
    if key is None and not _is_local(args.base_url):
        print("error: set GROQ_API_KEY (or AEGIS_MODEL_API_KEY)", file=sys.stderr)
        return 2
    extra_body = args.extra_body
    if extra_body is None:
        extra_body = GROQ_EXTRA_BODY if "api.groq.com" in args.base_url else {}

    ep = Endpoint(
        args.base_url,
        args.model,
        key,
        args.timeout,
        args.max_retries,
        args.retry_wait,
        extra_body,
    )
    code_word = _random_code_word()
    webp = make_fixture_image(code_word)

    report: dict = {
        "date": datetime.now(UTC).isoformat(timespec="seconds"),
        "base_url": args.base_url,
        "model": args.model,
        "client_host": f"{platform.node()} {platform.system()} {platform.release()}",
        "extra_body": extra_body,
        "image": {"format": image_format, "size": list(VIEWPORT), "bytes": len(webp)},
    }
    print("[text] ...", flush=True)
    report["text"] = check_text(ep)
    print(json.dumps(report["text"], indent=2, ensure_ascii=False, default=str), flush=True)
    if not report["text"]["pass"]:
        print(
            "error: the minimal authenticated call failed; not spending more calls", file=sys.stderr
        )
        report["rate_limited_429_total"] = ep.rate_limited_total
        _write(report, args.json_out)
        return 2

    steps = {
        "vision": lambda: check_vision(ep, webp, code_word),
        "grounding": lambda: check_grounding(ep, webp),
        "trials": lambda: run_trials(
            ep, args.trials, args.trial_words, with_grounding="grounding" not in args.skip
        ),
        "grounding_grid": lambda: run_grounding_grid(ep, args.grid_canvases),
        "kwargs": lambda: check_kwargs(ep),
        "structured": lambda: check_structured(ep),
        "gateway": lambda: check_gateway_request(ep),
        "latency": lambda: run_latency(ep, webp, args.runs, args.max_tokens),
    }
    for name, fn in steps.items():
        if (
            name in args.skip
            or (name == "trials" and args.trials < 1 and not args.trial_words)
            or (name == "grounding_grid" and not args.grounding_grid)
        ):
            continue
        print(f"[{name}] ...", flush=True)
        report[name] = fn()
        print(json.dumps(report[name], indent=2, ensure_ascii=False, default=str), flush=True)
    report["served_models"] = sorted(ep.served_models)
    report["served_providers"] = sorted(ep.served_providers)
    report["rate_limited_429_total"] = ep.rate_limited_total
    report["rate_limit_headers_last"] = ep.rate_limit_headers
    report["retry_policy"] = {"max_retries": args.max_retries, "wait_s": args.retry_wait}
    _write(report, args.json_out)

    lat = report.get("latency", {})
    if "ttft_s" in lat:
        print(
            f"\nlatency n={lat['n_ok']}/{lat['n']}"
            f"  TTFT p50 {lat['ttft_s']['p50']:.2f}s p95 {lat['ttft_s']['p95']:.2f}s"
            f"  total p50 {lat['total_s']['p50']:.2f}s p95 {lat['total_s']['p95']:.2f}s"
            f"  served={','.join(report['served_models'])}"
            f" via {','.join(report['served_providers'])}"
        )
    vision = report.get("vision")
    return 0 if vision is None or vision["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

"""
Generates the Phase-1 ~30-screen dev corpus (phase_1_contract_harness.md §5.3): writes
eval/corpus/dev/<screen_id>/{page/index.html, meta.json, screenshot.png-not-yet} and
eval/labels/<screen_id>.json for every fixture, deterministically (seeded), using the verified
checksum functions in checksums.py.

Every PII-bearing element is positioned with explicit inline `position:absolute; left/top/width/
height` CSS, in CSS pixels, so the label box in the JSON is exactly the rendered box by
construction — not measured after the fact. A spot-check against real Playwright-measured
getBoundingClientRect() is run separately (test_fixture_boxes_match_dom.py) to catch any box-model
surprise this reasoning might have missed.

Run with: `uv run python -m aegis_eval.corpus.generate_fixtures` (or the venv-direct equivalent).
Idempotent: re-running overwrites existing fixture output byte-for-byte from the same inputs.
"""

from __future__ import annotations

import hashlib
import json
import random
from dataclasses import dataclass, field
from pathlib import Path

from aegis_eval.corpus.checksums import gstin_generate, luhn_generate, verhoeff_generate

REPO_ROOT = Path(__file__).resolve().parents[4]
CORPUS_DEV = REPO_ROOT / "eval" / "corpus" / "dev"
LABELS_DIR = REPO_ROOT / "eval" / "labels"

VIEWPORT = (1280, 720)
DPR = 1

PAGE_CSS = """
  * { margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #fff; color: #111; }
  .field-label { position: absolute; font-size: 13px; color: #333; }
  .field-value { position: absolute; font-size: 14px; font-weight: 600; }
  .heading { position: absolute; top: 16px; left: 16px; font-size: 20px; font-weight: 700; }
  .box { position: absolute; border: 1px solid #ccc; background: #f7f7f7; }
"""


def sha256_hash(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def random_aadhaar_base(rng: random.Random) -> str:
    """11 digits, first digit constrained to 2-9 per the real Aadhaar format and
    `packages/recognizers/src/patterns/aadhaar.ts`'s `AADHAAR_RE` (`[2-9]\\d{3}...`). Every call
    site used to draw all 11 digits uniformly from 0-9, which ~20% of the time produced a
    checksum-valid but recognizer-*unmatchable* value (first digit 0 or 1) — an undetectable
    "Aadhaar" whose label still claimed it should be redacted. Found for real: the corpus-growth
    pass's `health-005` rolled exactly this and leaked its raw Aadhaar in a real harness run (the
    independent auditor caught it). Same bug class as the PAN holder-type-position bugs; same fix
    shape — correct it once, here, so every call site benefits."""
    return str(rng.randint(2, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(10))


@dataclass
class LabelItem:
    entity: str
    box: tuple[int, int, int, int]
    value_hash: str | None = None
    canary: bool = False
    canary_id: str | None = None
    note: str | None = None

    def to_json(self) -> dict:
        d: dict = {"entity": self.entity, "box": list(self.box)}
        if self.value_hash:
            d["value_hash"] = self.value_hash
        if self.canary:
            d["canary"] = True
            d["canary_id"] = self.canary_id
        if self.note:
            d["note"] = self.note
        return d


@dataclass
class Fixture:
    screen_id: str
    category: str
    group: str
    title: str
    body_html: str
    items: list[LabelItem] = field(default_factory=list)
    script: str = "latin"
    notes: str = ""
    tasks: list[str] = field(default_factory=list)

    def write(self) -> None:
        page_dir = CORPUS_DEV / self.screen_id / "page"
        page_dir.mkdir(parents=True, exist_ok=True)
        html = (
            f"<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
            f"<title>{self.title}</title>\n<style>{PAGE_CSS}</style>\n</head>\n<body>\n"
            f"{self.body_html}\n</body>\n</html>\n"
        )
        (page_dir / "index.html").write_text(html)

        meta = {
            "category": self.category,
            "group": self.group,
            "script": self.script,
            "viewport": list(VIEWPORT),
            "source": "hand-built",
            "licence": "synthetic — no real data",
            "notes": self.notes,
        }
        (CORPUS_DEV / self.screen_id / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")

        label = {
            "screen_id": self.screen_id,
            "viewport": list(VIEWPORT),
            "dpr": DPR,
            "items": [i.to_json() for i in self.items],
            "tasks": self.tasks,
        }
        (LABELS_DIR / f"{self.screen_id}.json").write_text(json.dumps(label, indent=2) + "\n")


def field_html(label: str, value: str, box: tuple[int, int, int, int], value_id: str) -> str:
    x, y, w, h = box
    return (
        f'<div class="field-label" style="left:{x}px;top:{y - 18}px;">{label}</div>'
        f'<div id="{value_id}" class="field-value" '
        f'style="left:{x}px;top:{y}px;width:{w}px;height:{h}px;">{value}</div>'
    )


def canary(rng: random.Random) -> str:
    return "CANARY" + "".join(rng.choices("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", k=22))


# --------------------------------------------------------------------------------------------
# Group: identifiers (8)
# --------------------------------------------------------------------------------------------


def build_identifiers(rng: random.Random) -> list[Fixture]:
    fixtures = []

    # id-001: Aadhaar, grouped
    base = random_aadhaar_base(rng)
    aadhaar = base + verhoeff_generate(base)
    grouped = f"{aadhaar[0:4]} {aadhaar[4:8]} {aadhaar[8:12]}"
    box = (220, 120, 160, 22)
    fixtures.append(
        Fixture(
            "id-001", "gov", "identifiers", "Aadhaar Enrolment Confirmation",
            '<div class="heading">Aadhaar Enrolment Confirmation</div>'
            + field_html("Aadhaar number", grouped, box, "aadhaar"),
            [LabelItem("AADHAAR", box, sha256_hash(aadhaar))],
            notes="Fictitious Aadhaar, valid Verhoeff checksum, grouped 4-4-4.",
        )
    )

    # id-002: Aadhaar, ungrouped
    base2 = random_aadhaar_base(rng)
    aadhaar2 = base2 + verhoeff_generate(base2)
    box2 = (220, 120, 140, 22)
    fixtures.append(
        Fixture(
            "id-002", "gov", "identifiers", "Aadhaar Update Request",
            '<div class="heading">Aadhaar Update Request</div>'
            + field_html("UID", aadhaar2, box2, "aadhaar"),
            [LabelItem("AADHAAR", box2, sha256_hash(aadhaar2))],
            notes="Fictitious Aadhaar, valid Verhoeff checksum, ungrouped.",
        )
    )

    # id-003: PAN
    # [Fixed, Phase 5] The real format's 4th character (of the 5-letter prefix) is a constrained
    # "holder type" code — packages/recognizers/src/patterns/pan.ts requires it to be one of
    # ABCFGHJLPT, exactly mirroring the real specification. This generator used to put the
    # valid-holder-type letter at the very END of the whole 10-character PAN instead (a position
    # the real format leaves unconstrained) — every PAN this fixture ever produced was therefore
    # correctly rejected as "not a real PAN" by the client's own recognizer, but the label still
    # claimed it should be redacted. Found for real by Phase 5's independent Python auditor
    # (`auditor/recognizers.py`) reporting a genuine leak against a real end-to-end harness run —
    # not by inspection. See docs/HISTORY.md's Phase 5 entry.
    pan_prefix3 = "".join(rng.choices("ABCDEFGHIJKLMNPQRSTUVWXYZ", k=3))
    pan_holder_type = rng.choice("ABCPFGHLTJ")
    pan_letter5 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan_digits = "".join(str(rng.randint(0, 9)) for _ in range(4))
    pan_letter2 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan = pan_prefix3 + pan_holder_type + pan_letter5 + pan_digits + pan_letter2
    box3 = (220, 120, 120, 22)
    fixtures.append(
        Fixture(
            "id-003", "banking", "identifiers", "PAN Verification",
            '<div class="heading">PAN Verification</div>'
            + field_html("PAN", pan, box3, "pan"),
            [LabelItem("PAN", box3, sha256_hash(pan))],
            notes="Fictitious PAN, structurally valid (5 letters, 4 digits, 1 letter; 4th letter is a real holder-type code).",
        )
    )

    # id-004: GSTIN
    state = f"{rng.randint(1, 37):02d}"
    prefix14 = state + pan + "1" + "Z"
    check = gstin_generate(prefix14)
    gstin = prefix14 + check
    box4 = (220, 120, 170, 22)
    fixtures.append(
        Fixture(
            "id-004", "banking", "identifiers", "GST Registration Lookup",
            '<div class="heading">GST Registration Lookup</div>'
            + field_html("GSTIN", gstin, box4, "gstin"),
            [LabelItem("GSTIN", box4, sha256_hash(gstin))],
            notes="Fictitious GSTIN, valid check character.",
        )
    )

    # id-005: IFSC
    bank = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=4))
    ifsc = bank + "0" + "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", k=6))
    box5 = (220, 120, 130, 22)
    fixtures.append(
        Fixture(
            "id-005", "banking", "identifiers", "Branch Locator",
            '<div class="heading">Branch Locator</div>'
            + field_html("IFSC code", ifsc, box5, "ifsc"),
            [LabelItem("IFSC", box5, sha256_hash(ifsc))],
            notes="Fictitious IFSC, structurally valid.",
        )
    )

    # id-006: UPI VPA
    handle = "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=8))
    vpa = f"{handle}{rng.randint(10,99)}@okhdfcbank"
    box6 = (220, 120, 180, 22)
    fixtures.append(
        Fixture(
            "id-006", "banking", "identifiers", "UPI Payment Confirmation",
            '<div class="heading">UPI Payment Confirmation</div>'
            + field_html("Paid to (UPI VPA)", vpa, box6, "vpa"),
            [LabelItem("UPI_VPA", box6, sha256_hash(vpa.lower()))],
            notes="Fictitious UPI VPA.",
        )
    )

    # id-007: card number, valid Luhn
    card_base = "4" + "".join(str(rng.randint(0, 9)) for _ in range(14))
    card = card_base + luhn_generate(card_base)
    card_grouped = " ".join(card[i : i + 4] for i in range(0, 16, 4))
    box7 = (220, 120, 190, 22)
    fixtures.append(
        Fixture(
            "id-007", "banking", "identifiers", "Saved Payment Method",
            '<div class="heading">Saved Payment Method</div>'
            + field_html("Card number", card_grouped, box7, "card"),
            [LabelItem("CARD_NUMBER", box7, sha256_hash(card))],
            notes="Fictitious card number, valid Luhn checksum, Visa-shaped IIN.",
        )
    )

    # id-008: Indian mobile + email
    mobile = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    email_local = "".join(rng.choices("abcdefghijklmnopqrstuvwxyz.", k=10)).strip(".")
    email = f"{email_local}@example.test"
    box8a = (220, 120, 150, 22)
    box8b = (220, 160, 220, 22)
    fixtures.append(
        Fixture(
            "id-008", "email", "identifiers", "Contact Details",
            '<div class="heading">Contact Details</div>'
            + field_html("Mobile", mobile, box8a, "mobile")
            + field_html("Email", email, box8b, "email"),
            [
                LabelItem("PHONE", box8a, sha256_hash(mobile.replace(" ", "").replace("+", ""))),
                LabelItem("EMAIL", box8b, sha256_hash(email.lower())),
            ],
            notes="Fictitious mobile and email.",
        )
    )

    return fixtures


# --------------------------------------------------------------------------------------------
# Group: hardneg (8) — must NOT be redacted; each is entity:NONE with a note (design.md §17, AC-11)
# --------------------------------------------------------------------------------------------


def build_hardneg(rng: random.Random) -> list[Fixture]:
    fixtures = []

    # hardneg-001: 16-digit order number shaped like a card but failing Luhn
    valid_base = "4" + "".join(str(rng.randint(0, 9)) for _ in range(14))
    valid_check = luhn_generate(valid_base)
    order_number = valid_base + str((int(valid_check) + 1) % 10)  # deliberately wrong check digit
    box = (220, 120, 190, 22)
    fixtures.append(
        Fixture(
            "hardneg-001", "docs", "hardneg", "Order Confirmation",
            '<div class="heading">Order Confirmation</div>'
            + field_html("Order number", " ".join(order_number[i:i+4] for i in range(0,16,4)), box, "order"),
            [LabelItem("NONE", box, note="16-digit order number, card-shaped, deliberately fails Luhn")],
            notes="Hard negative: card-shaped but Luhn-invalid.",
        )
    )

    # hardneg-002: 12-digit tracking id failing Verhoeff
    base = random_aadhaar_base(rng)
    valid_check_v = verhoeff_generate(base)
    tracking_id = base + str((int(valid_check_v) + 1) % 10)  # deliberately wrong
    box = (220, 120, 160, 22)
    fixtures.append(
        Fixture(
            "hardneg-002", "docs", "hardneg", "Shipment Tracking",
            '<div class="heading">Shipment Tracking</div>'
            + field_html("Tracking ID", tracking_id, box, "tracking"),
            [LabelItem("NONE", box, note="12-digit tracking id, Aadhaar-shaped, deliberately fails Verhoeff")],
            notes="Hard negative: Aadhaar-shaped but Verhoeff-invalid.",
        )
    )

    # hardneg-003: PAN-shaped catalogue product code
    # [Fixed, Phase 5 continued] Same bug class as id-003 (see its comment above): the real PAN
    # format's constrained "holder type" code is the 4th character of the 10-char string, not the
    # last one. This generator put its deliberately-invalid 'X' at the END instead, leaving the
    # real holder-type position (letters[3]) a uniformly-random letter — ~40% of the time (any of
    # ABCFGHJLPT) that made the "hard negative" a structurally VALID PAN, which the client's
    # correct recognizer then (correctly, by its own rules) flagged as PAN, scored as a false
    # positive against the ground truth's `entity: NONE`. Found the same way as id-003: the
    # independent auditor / real harness run, not by inspection.
    pan_prefix3 = "".join(rng.choices("ABCDEFGHIJKLMNPQRSTUVWXYZ", k=3))
    pan_letter5 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    digits = "".join(str(rng.randint(0, 9)) for _ in range(4))
    pan_letter10 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    # 'X' is not in the real PAN holder-type set; placed at position 4 (the actual holder-type slot)
    product_code = pan_prefix3 + "X" + pan_letter5 + digits + pan_letter10
    box = (220, 120, 120, 22)
    fixtures.append(
        Fixture(
            "hardneg-003", "docs", "hardneg", "Product Catalogue",
            '<div class="heading">Product Catalogue</div>'
            + field_html("SKU", product_code, box, "sku"),
            [LabelItem("NONE", box, note="PAN-shaped catalogue SKU; 4th-char holder-type code is invalid for a real PAN")],
            notes="Hard negative: PAN-pattern-shaped but not a PAN (invalid holder-type code).",
        )
    )

    # hardneg-004: price that looks like it could be flagged as an amount/account number
    price = f"Rs. {rng.randint(1000, 99999):,}.00"
    box = (220, 120, 140, 22)
    fixtures.append(
        Fixture(
            "hardneg-004", "docs", "hardneg", "Invoice",
            '<div class="heading">Invoice</div>' + field_html("Total", price, box, "total"),
            [LabelItem("NONE", box, note="a price — LOW class, must pass through, not redacted")],
            notes="Hard negative: a plain amount.",
        )
    )

    # hardneg-005: a date with no DOB context
    date_str = f"{rng.randint(1,28):02d}/{rng.randint(1,12):02d}/2025"
    box = (220, 120, 110, 22)
    fixtures.append(
        Fixture(
            "hardneg-005", "docs", "hardneg", "Meeting Notes",
            '<div class="heading">Meeting Notes</div>'
            + field_html("Next review date", date_str, box, "date"),
            [LabelItem("NONE", box, note="a calendar date with no DOB context — must not be flagged as DOB")],
            notes="Hard negative: a generic date, not a date of birth.",
        )
    )

    # hardneg-006: 6-digit number with no address context (not a PIN code)
    six_digit = str(rng.randint(100000, 999999))
    box = (220, 120, 100, 22)
    fixtures.append(
        Fixture(
            "hardneg-006", "docs", "hardneg", "Support Ticket",
            '<div class="heading">Support Ticket</div>'
            + field_html("Ticket number", six_digit, box, "ticket"),
            [LabelItem("NONE", box, note="6-digit ticket number with no address context — must not be flagged as a PIN code")],
            notes="Hard negative: 6-digit number, not a postal PIN code.",
        )
    )

    # hardneg-007: vehicle-registration-shaped but a warehouse rack code
    # [Fixed, corpus growth pass] The rack code used `rng.choice('AB')` — ONE character drawn from
    # the string "AB" (i.e. a single letter 'A' or 'B'), not a 2-letter prefix. `vehicle.ts`'s
    # `VEHICLE_RE` requires exactly `[A-Z]{2}` first, so this value was never vehicle-shaped enough
    # to reach the recognizer's state-code check at all — the hard negative was "safe" for the
    # wrong reason (shape mismatch, not the claimed invalid-state-code rejection). Fixed to use a
    # real 2-letter prefix that is deliberately NOT in `vehicle.ts`'s real state-code table.
    rack_state = rng.choice(["ZZ", "XX", "QQ"])
    rack_code = f"{rack_state}{rng.randint(10,99)} {rng.choice('CD')}{rng.randint(1,9)} {rng.randint(1000,9999)}"
    box = (220, 120, 150, 22)
    fixtures.append(
        Fixture(
            "hardneg-007", "docs", "hardneg", "Warehouse Inventory",
            '<div class="heading">Warehouse Inventory</div>'
            + field_html("Rack code", rack_code, box, "rack"),
            [LabelItem("NONE", box, note="vehicle-registration-shaped rack code with an invalid (non-real) state code — must not be flagged as VEHICLE_REG")],
            notes="Hard negative: vehicle-reg-shaped, correct shape, but an invalid state-code prefix.",
        )
    )

    # hardneg-008: masked/partial Aadhaar-like display that should not be treated as a full value
    masked = "XXXX XXXX " + "".join(str(rng.randint(0, 9)) for _ in range(4))
    box = (220, 120, 160, 22)
    fixtures.append(
        Fixture(
            "hardneg-008", "gov", "hardneg", "Account Summary",
            '<div class="heading">Account Summary</div>'
            + field_html("Aadhaar on file (masked)", masked, box, "masked_aadhaar"),
            [LabelItem("NONE", box, note="already-masked display (8 digits hidden) — no full value present to leak")],
            notes="Hard negative: pre-masked display, not a full identifier.",
        )
    )

    # hardneg-009: a real postal PIN code with real address context — PIN_CODE is policy class
    # LOW (default.policy.json), whose threshold (0.85) sits above even the with-context score
    # pin.ts ever returns (0.7) — a PIN code is deliberately never redacted, by design, even with
    # perfect context. This is a regression fixture for that policy fact, not a detection gap.
    pincode = str(rng.randint(110000, 899999))
    box = (220, 120, 200, 22)
    fixtures.append(
        Fixture(
            "hardneg-009", "docs", "hardneg", "Delivery Address",
            '<div class="heading">Delivery Address</div>'
            + field_html("PIN code", pincode, box, "pincode"),
            [LabelItem("NONE", box, note="a real-shaped postal PIN code with address context — PIN_CODE is policy class LOW and is never redacted by design, even with context")],
            notes="Hard negative: real PIN-code shape and context, but LOW class by design.",
        )
    )

    # hardneg-010: a masked/partial card number (only the last 4 digits shown)
    masked_card = "**** **** **** " + "".join(str(rng.randint(0, 9)) for _ in range(4))
    box = (220, 120, 190, 22)
    fixtures.append(
        Fixture(
            "hardneg-010", "banking", "hardneg", "Payment History",
            '<div class="heading">Payment History</div>'
            + field_html("Card on file", masked_card, box, "masked_card"),
            [LabelItem("NONE", box, note="already-masked display (12 digits hidden) — no full card number present to leak")],
            notes="Hard negative: pre-masked card display, not a full card number.",
        )
    )

    # hardneg-011: an 8-digit reference number — not 12-digit Aadhaar-shaped, not 16-digit
    # card-shaped, no label context of any kind. A baseline "plain number" case.
    ref_number = "".join(str(rng.randint(0, 9)) for _ in range(8))
    box = (220, 120, 110, 22)
    fixtures.append(
        Fixture(
            "hardneg-011", "docs", "hardneg", "Reference Lookup",
            '<div class="heading">Reference Lookup</div>'
            + field_html("Reference number", ref_number, box, "ref"),
            [LabelItem("NONE", box, note="an 8-digit reference number — not shaped like any modelled identifier")],
            notes="Hard negative: a plain reference number.",
        )
    )

    # hardneg-012: an age shown as a plain number next to a birth-year-shaped number — a social
    # profile convention, not a DOB field (complements hardneg-005's date-shaped hard negative
    # with a different DOB-adjacent shape: a bare age/year pair).
    age = rng.randint(18, 65)
    birth_year = 2025 - age
    box = (16, 60, 120, 20)
    fixtures.append(
        Fixture(
            "hardneg-012", "social", "hardneg", "Dating Profile",
            f'<div id="age" style="position:absolute;left:{box[0]}px;top:{box[1]}px;">'
            f"{age}, born {birth_year}</div>",
            [LabelItem("NONE", box, note="age and birth year as plain prose, not a DOB field — must not be flagged as DOB")],
            notes="Hard negative: age/birth-year, not a date-of-birth pattern.",
        )
    )

    return fixtures


# --------------------------------------------------------------------------------------------
# Group: forms (4) — login/payment forms with presence-only fields
# --------------------------------------------------------------------------------------------


def build_forms(rng: random.Random) -> list[Fixture]:
    fixtures = []

    # forms-001: login form, password already filled (the strategy's own demo shape)
    username = "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=8))
    password_len = rng.randint(8, 14)
    user_box = (220, 120, 220, 28)
    pass_box = (220, 160, 220, 28)
    submit_box = (220, 200, 100, 32)
    fixtures.append(
        Fixture(
            "forms-001", "banking", "forms", "Sign In",
            '<div class="heading">Sign In</div>'
            + field_html("Username", username, user_box, "username")
            + f'<div class="field-label" style="left:220px;top:142px;">Password</div>'
              f'<input id="password" type="password" value="{"x" * password_len}" '
              f'style="position:absolute;left:{pass_box[0]}px;top:{pass_box[1]}px;'
              f'width:{pass_box[2]}px;height:{pass_box[3]}px;">'
            + f'<button id="submit" style="position:absolute;left:{submit_box[0]}px;'
              f'top:{submit_box[1]}px;width:{submit_box[2]}px;height:{submit_box[3]}px;">Sign in</button>',
            [
                LabelItem("USERNAME", user_box, sha256_hash(username)),
                LabelItem("PASSWORD", pass_box, note=None),
            ],
            notes=f"Password field pre-filled ({password_len} chars) — presence only, value never read.",
            tasks=["task-login-submit-01"],
        )
    )

    # forms-002: OTP field
    otp_box = (220, 120, 120, 28)
    fixtures.append(
        Fixture(
            "forms-002", "banking", "forms", "Verify OTP",
            '<div class="heading">Verify OTP</div>'
            + f'<div class="field-label" style="left:220px;top:102px;">One-time code</div>'
              f'<input id="otp" autocomplete="one-time-code" type="text" value="482913" '
              f'style="position:absolute;left:{otp_box[0]}px;top:{otp_box[1]}px;'
              f'width:{otp_box[2]}px;height:{otp_box[3]}px;">',
            [LabelItem("OTP", otp_box)],
            notes="OTP field — presence only.",
        )
    )

    # forms-003: card number + CVV
    card_num_box = (220, 120, 190, 28)
    cvv_box = (220, 160, 60, 28)
    fixtures.append(
        Fixture(
            "forms-003", "banking", "forms", "Add Payment Method",
            '<div class="heading">Add Payment Method</div>'
            + f'<div class="field-label" style="left:220px;top:102px;">Card number</div>'
              f'<input id="cc-number" autocomplete="cc-number" type="text" value="4111111111111111" '
              f'style="position:absolute;left:{card_num_box[0]}px;top:{card_num_box[1]}px;'
              f'width:{card_num_box[2]}px;height:{card_num_box[3]}px;">'
            + f'<div class="field-label" style="left:220px;top:142px;">CVV</div>'
              f'<input id="cc-csc" autocomplete="cc-csc" type="text" value="123" '
              f'style="position:absolute;left:{cvv_box[0]}px;top:{cvv_box[1]}px;'
              f'width:{cvv_box[2]}px;height:{cvv_box[3]}px;">',
            [
                LabelItem("CARD_NUMBER", card_num_box),
                LabelItem("CARD_CVV", cvv_box),
            ],
            notes="Card number and CVV fields — presence only, never read.",
        )
    )

    # forms-004: KYC form (name, DOB, address, Aadhaar)
    name = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(
        rng.choices("abcdefghijklmnopqrstuvwxyz", k=6)
    ) + " " + "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(
        rng.choices("abcdefghijklmnopqrstuvwxyz", k=7)
    )
    dob = f"{rng.randint(1,28):02d}-{rng.randint(1,12):02d}-19{rng.randint(60,99)}"
    base_k = random_aadhaar_base(rng)
    aadhaar_k = base_k + verhoeff_generate(base_k)
    name_box = (220, 120, 220, 24)
    dob_box = (220, 160, 120, 24)
    aadhaar_box = (220, 200, 160, 24)
    fixtures.append(
        Fixture(
            "forms-004", "gov", "forms", "KYC Verification",
            '<div class="heading">KYC Verification</div>'
            + field_html("Full name", name, name_box, "name")
            + field_html("Date of birth", dob, dob_box, "dob")
            + field_html("Aadhaar number", aadhaar_k, aadhaar_box, "aadhaar"),
            [
                LabelItem("PERSON_NAME", name_box, sha256_hash(name.lower())),
                LabelItem("DOB", dob_box, sha256_hash(dob)),
                LabelItem("AADHAAR", aadhaar_box, sha256_hash(aadhaar_k)),
            ],
            notes="Fictitious KYC form: name, DOB with label context, Aadhaar.",
        )
    )

    return fixtures


# --------------------------------------------------------------------------------------------
# Group: faces (4) — placeholder graphics only; no real photographs (design.md §17)
# --------------------------------------------------------------------------------------------


def _svg_placeholder(kind: str, width: int, height: int) -> str:
    """A simple, clearly-synthetic SVG standing in for imagery the client's vision channel would
    see (Phase 4+). No real photographs are used anywhere in this corpus."""
    labels = {
        "face": ('<circle cx="50%" cy="40%" r="25%" fill="#c9a27e"/>'
                 '<ellipse cx="50%" cy="80%" rx="35%" ry="20%" fill="#c9a27e"/>'),
        "id_document": '<rect x="5%" y="10%" width="90%" height="80%" fill="#e8eef5" stroke="#8899aa"/>'
                        '<rect x="10%" y="20%" width="30%" height="40%" fill="#c9a27e"/>'
                        '<rect x="45%" y="25%" width="45%" height="8%" fill="#8899aa"/>'
                        '<rect x="45%" y="40%" width="45%" height="8%" fill="#8899aa"/>',
        "signature": '<path d="M10,50 Q30,10 50,50 T90,50" stroke="#222" fill="none" stroke-width="3"/>',
        "qr_code": "".join(
            f'<rect x="{(i%8)*12}%" y="{(i//8)*12}%" width="10%" height="10%" fill="#000"/>'
            for i in range(64) if (i * 7 + i // 8) % 3 == 0
        ),
    }
    return (
        f'<svg width="{width}" height="{height}" viewBox="0 0 100 100" '
        f'xmlns="http://www.w3.org/2000/svg" style="background:#fafafa;border:1px solid #ddd;">'
        f"{labels[kind]}</svg>"
    )


def build_faces(_rng: random.Random) -> list[Fixture]:
    fixtures = []

    box = (40, 100, 96, 96)
    fixtures.append(
        Fixture(
            "faces-001", "social", "faces", "Profile",
            '<div class="heading">Profile</div>'
            + f'<div id="face-region" style="position:absolute;left:{box[0]}px;top:{box[1]}px;">'
              f'{_svg_placeholder("face", box[2], box[3])}</div>',
            [LabelItem("FACE", box)],
            notes="Placeholder avatar graphic, not a real photograph — see eval/corpus/README.md.",
        )
    )

    box2 = (220, 120, 260, 160)
    fixtures.append(
        Fixture(
            "faces-002", "gov", "faces", "Identity Verification",
            '<div class="heading">Identity Verification</div>'
            + f'<div id="id-document-region" style="position:absolute;left:{box2[0]}px;top:{box2[1]}px;">'
              f'{_svg_placeholder("id_document", box2[2], box2[3])}</div>',
            [LabelItem("ID_DOCUMENT", box2)],
            notes="Placeholder ID-document graphic, redacted whole without attempting to read it.",
        )
    )

    box3 = (220, 120, 200, 80)
    fixtures.append(
        Fixture(
            "faces-003", "banking", "faces", "Cheque Deposit",
            '<div class="heading">Cheque Deposit</div>'
            + f'<div id="signature-region" style="position:absolute;left:{box3[0]}px;top:{box3[1]}px;">'
              f'{_svg_placeholder("signature", box3[2], box3[3])}</div>',
            [LabelItem("SIGNATURE", box3)],
            notes="Placeholder signature graphic.",
        )
    )

    box4 = (220, 120, 120, 120)
    fixtures.append(
        Fixture(
            "faces-004", "docs", "faces", "Scan to Pay",
            '<div class="heading">Scan to Pay</div>'
            + f'<div id="qr-code-region" style="position:absolute;left:{box4[0]}px;top:{box4[1]}px;">'
              f'{_svg_placeholder("qr_code", box4[2], box4[3])}</div>',
            [LabelItem("QR_CODE", box4)],
            notes="Placeholder QR-code graphic (not a real scannable code).",
        )
    )

    return fixtures


# --------------------------------------------------------------------------------------------
# Group: freetext (3)
# --------------------------------------------------------------------------------------------


def build_freetext(rng: random.Random) -> list[Fixture]:
    fixtures = []

    name = "Ramesh " + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=6)).capitalize()
    addr = f"{rng.randint(1,999)} MG Road, Apartment {rng.randint(1,50)}, Bengaluru"
    box_name = (16, 60, 300, 24)
    box_addr = (16, 90, 400, 24)
    fixtures.append(
        Fixture(
            "freetext-001", "social", "freetext", "About Me",
            # This <p> is deliberately NOT position:absolute — it stays in normal flow so it does
            # not become a containing block for #name below. #name is position:absolute itself,
            # so it is placed directly via left/top relative to the viewport, matching box_name
            # exactly (verified by test_fixture_boxes_match_dom.py; an earlier version nested it
            # inside a positioned <p>, which silently shifted its rendered position — see the
            # Phase 1 Implementation Notes for the full account).
            f'<p style="position:static;">'
            f'Hi, I am <span id="name" style="position:absolute;left:{box_name[0]}px;top:{box_name[1]}px;">'
            f"{name}</span></p>"
            f'<p id="addr" style="position:absolute;left:{box_addr[0]}px;top:{box_addr[1]}px;">'
            f"I live at {addr}.</p>",
            [
                LabelItem("PERSON_NAME", box_name, sha256_hash(name.lower())),
                LabelItem("ADDRESS", box_addr, sha256_hash(addr.lower())),
            ],
            notes="Name and address embedded in free-flowing prose, not a labelled form field.",
        )
    )

    sender = "Priya " + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=5)).capitalize()
    phone = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    box_sender = (16, 60, 200, 20)
    # The whole sentence "Call me at <phone> when you land" is one text node — its bounding box
    # covers the full line, not just the digits (design.md §7.1's OCR line-fallback behaviour:
    # a low-confidence partial match expands to the whole line). 340px was measured against the
    # real rendered fixture, not guessed, since the line's width depends on the random phone
    # digits and font metrics.
    box_phone = (16, 90, 340, 20)
    fixtures.append(
        Fixture(
            "freetext-002", "social", "freetext", "Chat",
            f'<div id="sender" style="position:absolute;left:{box_sender[0]}px;top:{box_sender[1]}px;">'
            f"{sender}:</div>"
            f'<div id="phone" style="position:absolute;left:{box_phone[0]}px;top:{box_phone[1]}px;">'
            f"Call me at {phone} when you land</div>",
            [
                LabelItem("PERSON_NAME", box_sender, sha256_hash(sender.lower())),
                LabelItem("PHONE", box_phone, sha256_hash(phone.replace(" ", "").replace("+", ""))),
            ],
            notes="Chat transcript with a name and a phone number in free text.",
        )
    )

    full_name = "Dr. " + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=7)).capitalize()
    email = "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=9)) + "@example.test"
    box_fn = (16, 60, 260, 22)
    box_em = (16, 90, 260, 22)
    fixtures.append(
        Fixture(
            "freetext-003", "docs", "freetext", "Staff Directory",
            f'<div id="fn" style="position:absolute;left:{box_fn[0]}px;top:{box_fn[1]}px;">'
            f"{full_name}, Department of Radiology</div>"
            f'<div id="em" style="position:absolute;left:{box_em[0]}px;top:{box_em[1]}px;">{email}</div>',
            [
                LabelItem("PERSON_NAME", box_fn, sha256_hash(full_name.lower())),
                LabelItem("EMAIL", box_em, sha256_hash(email.lower())),
            ],
            notes="A profile/directory page with a name and email in prose.",
            script="latin",
        )
    )

    return fixtures


# --------------------------------------------------------------------------------------------
# Group: canvas (1)
# --------------------------------------------------------------------------------------------


def build_canvas(rng: random.Random) -> list[Fixture]:
    base = random_aadhaar_base(rng)
    aadhaar = base + verhoeff_generate(base)
    # The canvas element sits at page position (20, 80). ctx.fillText('{aadhaar}', 20, 90) draws
    # the value at local (20, 90), baseline-anchored — page position (40, 90+80=170) at the
    # baseline. Box below is that position adjusted for bold-16px ascent/descent, in page
    # coordinates; see the note on why this is an approximation, not a measurement.
    box = (40, 154, 130, 22)
    canvas_js = f"""
<script>
  const c = document.getElementById('cv');
  const ctx = c.getContext('2d');
  ctx.font = '16px sans-serif';
  ctx.fillStyle = '#111';
  ctx.fillText('Aadhaar on file:', 20, 60);
  ctx.font = 'bold 16px sans-serif';
  ctx.fillText('{aadhaar}', 20, 90);
</script>
"""
    return [
        Fixture(
            "canvas-001", "canvas_app", "canvas", "Canvas-Rendered Form",
            '<div class="heading">Canvas-Rendered Form</div>'
            f'<canvas id="cv" width="400" height="200" '
            f'style="position:absolute;left:20px;top:80px;border:1px solid #ccc;"></canvas>'
            + canvas_js,
            [LabelItem("AADHAAR", box, sha256_hash(aadhaar))],
            notes=(
                "Canvas-rendered text — the DOM has no accessible representation of this value; "
                "only Channel V / OCR (Phase 6) can see it. Box is an approximation of the drawn "
                "text's on-canvas position for corpus purposes; exact glyph metrics were not "
                "measured, since no OCR exists yet to consume this fixture."
            ),
        )
    ]


# --------------------------------------------------------------------------------------------
# Group: pdf (1) — a placeholder PDF-viewer-shaped page; real PDF.js integration is Phase 6
# --------------------------------------------------------------------------------------------


def build_pdf(rng: random.Random) -> list[Fixture]:
    base = random_aadhaar_base(rng)
    aadhaar = base + verhoeff_generate(base)
    # The viewer frame div below is itself position:absolute at (40, 60), which establishes a
    # new containing block — field_html's left/top are CSS relative to that frame, not the
    # viewport. local_box is what's passed to the CSS; box (viewport-absolute) is what's labelled,
    # matching this corpus's convention that every label box is a top-level viewport coordinate
    # (design.md's own convention). Caught by test_fixture_boxes_match_dom.py, which measures the
    # real rendered position rather than trusting this arithmetic.
    frame_origin = (40, 60)
    local_box = (80, 160, 160, 22)
    box = (frame_origin[0] + local_box[0], frame_origin[1] + local_box[1], local_box[2], local_box[3])
    return [
        Fixture(
            "pdf-001", "docs", "pdf", "Document Viewer",
            '<div class="heading">Document Viewer</div>'
            f'<div style="position:absolute;left:{frame_origin[0]}px;top:{frame_origin[1]}px;width:500px;height:600px;'
            'background:#fff;border:1px solid #999;box-shadow:0 0 8px rgba(0,0,0,0.15);">'
            '<div style="padding:20px;font-size:13px;color:#666;">Enrolment_Confirmation.pdf — page 1 of 1</div>'
            + field_html("Aadhaar number", aadhaar, local_box, "aadhaar")
            + "</div>",
            [LabelItem("AADHAAR", box, sha256_hash(aadhaar))],
            notes=(
                "A page styled to represent a PDF viewer frame, not a real embedded PDF.js "
                "instance — full PDF.js integration is Phase 6 (F-C07). Structurally exercises "
                "the 'docs' category and an unexplained-region shape for later phases."
            ),
        )
    ]


# --------------------------------------------------------------------------------------------
# Group: indic (1) — Devanagari script, incl. Devanagari digits
# --------------------------------------------------------------------------------------------

_DEVANAGARI_DIGITS = "०१२३४५६७८९"


def _to_devanagari_digits(s: str) -> str:
    return "".join(_DEVANAGARI_DIGITS[int(c)] if c.isdigit() else c for c in s)


def build_indic(rng: random.Random) -> list[Fixture]:
    base = random_aadhaar_base(rng)
    aadhaar = base + verhoeff_generate(base)
    aadhaar_deva = _to_devanagari_digits(f"{aadhaar[0:4]} {aadhaar[4:8]} {aadhaar[8:12]}")
    box = (220, 120, 180, 24)
    return [
        Fixture(
            "indic-001", "gov", "indic", "आधार नोंदणी पुष्टीकरण",
            '<div class="heading">आधार नोंदणी पुष्टीकरण</div>'
            + field_html("आधार क्रमांक", aadhaar_deva, box, "aadhaar"),
            [LabelItem("AADHAAR", box, sha256_hash(aadhaar))],
            notes="Devanagari script incl. Devanagari digit forms (०-९) for the Aadhaar number.",
            script="devanagari",
        )
    ]


def build_indic_extra(rng: random.Random) -> list[Fixture]:
    """More Indic-script pages beyond `indic-001`'s single Devanagari fixture — corpus growth
    pass. Script text is real Tamil/Bengali/Devanagari prose (transliterated fictitious names,
    not machine-translated gibberish); digits stay ASCII except where a script has its own digit
    forms in real use, per `indic-001`'s existing precedent."""
    fixtures = []

    # indic-002: Tamil-script government portal — Aadhaar with a Tamil label
    base = random_aadhaar_base(rng)
    aadhaar = base + verhoeff_generate(base)
    grouped = f"{aadhaar[0:4]} {aadhaar[4:8]} {aadhaar[8:12]}"
    box = (220, 120, 160, 24)
    fixtures.append(
        Fixture(
            "indic-002", "gov", "indic", "ஆதார் பதிவு உறுதிப்படுத்தல்",
            '<div class="heading">ஆதார் பதிவு உறுதிப்படுத்தல்</div>'
            + field_html("ஆதார் எண்", grouped, box, "aadhaar"),
            [LabelItem("AADHAAR", box, sha256_hash(aadhaar))],
            notes="Tamil-script government portal; Aadhaar digits stay ASCII (real-world convention).",
            script="tamil",
        )
    )

    # indic-003: Bengali-script banking form — IFSC with a Bengali label
    bank = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=4))
    ifsc = bank + "0" + "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", k=6))
    box2 = (220, 120, 140, 22)
    fixtures.append(
        Fixture(
            "indic-003", "banking", "indic", "শাখা অনুসন্ধান",
            '<div class="heading">শাখা অনুসন্ধান</div>'
            + field_html("আইএফএসসি কোড", ifsc, box2, "ifsc"),
            [LabelItem("IFSC", box2, sha256_hash(ifsc))],
            notes="Bengali-script banking form; fictitious IFSC, structurally valid.",
            script="bengali",
        )
    )

    # indic-004: Devanagari free-text chat — a phone number embedded in Hindi prose
    phone = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    phone_deva = _to_devanagari_digits(phone)
    box3 = (16, 60, 340, 22)
    fixtures.append(
        Fixture(
            "indic-004", "social", "indic", "चैट",
            f'<div id="msg" style="position:absolute;left:{box3[0]}px;top:{box3[1]}px;">'
            f"मुझे {phone_deva} पर कॉल करें।</div>",
            [LabelItem("PHONE", box3, sha256_hash(phone.replace(" ", "").replace("+", "")))],
            notes="Devanagari-script chat message with a phone number in Devanagari digit forms.",
            script="devanagari",
        )
    )

    return fixtures


def build_faces_extra(_rng: random.Random) -> list[Fixture]:
    """More vision-channel-shaped pages beyond `faces-001..004` — corpus growth pass. Placeholder
    SVG graphics only, same as `build_faces` (design.md §17: no real photographs)."""
    fixtures = []

    box = (480, 260, 140, 140)
    fixtures.append(
        Fixture(
            "faces-005", "social", "faces", "Video Call",
            '<div class="heading">Video Call</div>'
            + f'<div id="self-preview" style="position:absolute;left:{box[0]}px;top:{box[1]}px;'
              f'border:2px solid #4a90d9;">{_svg_placeholder("face", box[2], box[3])}</div>',
            [LabelItem("FACE", box)],
            notes="Placeholder self-preview tile in a video-call UI, not a static profile picture.",
        )
    )

    box2a = (220, 120, 180, 180)
    box2b = (420, 140, 220, 140)
    fixtures.append(
        Fixture(
            "faces-006", "gov", "faces", "Selfie Verification",
            '<div class="heading">Selfie Verification</div>'
            + f'<div id="selfie-region" style="position:absolute;left:{box2a[0]}px;top:{box2a[1]}px;">'
              f'{_svg_placeholder("face", box2a[2], box2a[3])}</div>'
            + f'<div id="id-doc-region" style="position:absolute;left:{box2b[0]}px;top:{box2b[1]}px;">'
              f'{_svg_placeholder("id_document", box2b[2], box2b[3])}</div>',
            [LabelItem("FACE", box2a), LabelItem("ID_DOCUMENT", box2b)],
            notes="A KYC liveness-check flow: a live selfie region next to a held-up ID document.",
        )
    )

    box3a = (60, 100, 120, 120)
    box3b = (200, 100, 120, 120)
    fixtures.append(
        Fixture(
            "faces-007", "docs", "faces", "Team Meeting",
            '<div class="heading">Team Meeting</div>'
            + f'<div id="tile-1" style="position:absolute;left:{box3a[0]}px;top:{box3a[1]}px;">'
              f'{_svg_placeholder("face", box3a[2], box3a[3])}</div>'
            + f'<div id="tile-2" style="position:absolute;left:{box3b[0]}px;top:{box3b[1]}px;">'
              f'{_svg_placeholder("face", box3b[2], box3b[3])}</div>',
            [LabelItem("FACE", box3a), LabelItem("FACE", box3b)],
            notes="A group video-call grid — two independent FACE regions on one screen.",
        )
    )

    return fixtures


def build_canvas_extra(rng: random.Random) -> list[Fixture]:
    """More canvas-rendered pages beyond `canvas-001` — corpus growth pass. Same DOM-invisibility
    property: only Channel V / OCR (Phase 6) could ever see these values."""
    fixtures = []

    handle = "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=8))
    vpa = f"{handle}{rng.randint(10,99)}@oksbi"
    box = (40, 154, 160, 22)
    canvas_js = f"""
<script>
  const c = document.getElementById('cv');
  const ctx = c.getContext('2d');
  ctx.font = '16px sans-serif';
  ctx.fillStyle = '#111';
  ctx.fillText('Pay to:', 20, 60);
  ctx.font = 'bold 16px sans-serif';
  ctx.fillText('{vpa}', 20, 90);
</script>
"""
    fixtures.append(
        Fixture(
            "canvas-002", "canvas_app", "canvas", "Drawing Board Receipt",
            '<div class="heading">Drawing Board Receipt</div>'
            f'<canvas id="cv" width="400" height="200" '
            f'style="position:absolute;left:20px;top:80px;border:1px solid #ccc;"></canvas>'
            + canvas_js,
            [LabelItem("UPI_VPA", box, sha256_hash(vpa.lower()))],
            notes="Canvas-rendered UPI VPA in a drawing/whiteboard-style app — DOM has no accessible text.",
        )
    )

    pan_prefix3 = "".join(rng.choices("ABCDEFGHIJKLMNPQRSTUVWXYZ", k=3))
    pan_holder_type = rng.choice("ABCPFGHLTJ")
    pan_letter5 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan_digits = "".join(str(rng.randint(0, 9)) for _ in range(4))
    pan_letter2 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan = pan_prefix3 + pan_holder_type + pan_letter5 + pan_digits + pan_letter2
    box2 = (40, 154, 140, 22)
    canvas_js2 = f"""
<script>
  const c2 = document.getElementById('cv2');
  const ctx2 = c2.getContext('2d');
  ctx2.font = '16px sans-serif';
  ctx2.fillStyle = '#111';
  ctx2.fillText('PAN on file:', 20, 60);
  ctx2.font = 'bold 16px sans-serif';
  ctx2.fillText('{pan}', 20, 90);
</script>
"""
    fixtures.append(
        Fixture(
            "canvas-003", "canvas_app", "canvas", "Analytics Dashboard",
            '<div class="heading">Analytics Dashboard</div>'
            f'<canvas id="cv2" width="400" height="200" '
            f'style="position:absolute;left:20px;top:80px;border:1px solid #ccc;"></canvas>'
            + canvas_js2,
            [LabelItem("PAN", box2, sha256_hash(pan))],
            notes="Canvas-rendered PAN in a chart/dashboard-style app — DOM has no accessible text.",
        )
    )

    return fixtures


def build_pdf_extra(rng: random.Random) -> list[Fixture]:
    """More PDF-viewer-shaped pages beyond `pdf-001` — corpus growth pass. Same disclosed caveat:
    a page styled like a PDF.js frame, not a real embedded PDF.js instance (Phase 6, F-C07)."""
    fixtures = []

    frame_origin = (40, 60)

    name = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(
        rng.choices("abcdefghijklmnopqrstuvwxyz", k=6)
    ) + " " + "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(
        rng.choices("abcdefghijklmnopqrstuvwxyz", k=7)
    )
    email = "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=9)) + "@example.test"
    phone = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    local_name = (80, 120, 220, 22)
    local_email = (80, 150, 220, 22)
    local_phone = (80, 180, 200, 22)
    box_name = (frame_origin[0] + local_name[0], frame_origin[1] + local_name[1], local_name[2], local_name[3])
    box_email = (frame_origin[0] + local_email[0], frame_origin[1] + local_email[1], local_email[2], local_email[3])
    box_phone = (frame_origin[0] + local_phone[0], frame_origin[1] + local_phone[1], local_phone[2], local_phone[3])
    fixtures.append(
        Fixture(
            "pdf-002", "docs", "pdf", "Resume Viewer",
            '<div class="heading">Resume Viewer</div>'
            f'<div style="position:absolute;left:{frame_origin[0]}px;top:{frame_origin[1]}px;width:500px;height:600px;'
            'background:#fff;border:1px solid #999;box-shadow:0 0 8px rgba(0,0,0,0.15);">'
            '<div style="padding:20px;font-size:13px;color:#666;">Resume.pdf — page 1 of 1</div>'
            + field_html("Name", name, local_name, "name")
            + field_html("Email", email, local_email, "email")
            + field_html("Phone", phone, local_phone, "phone")
            + "</div>",
            [
                LabelItem("PERSON_NAME", box_name, sha256_hash(name.lower())),
                LabelItem("EMAIL", box_email, sha256_hash(email.lower())),
                LabelItem("PHONE", box_phone, sha256_hash(phone.replace(" ", "").replace("+", ""))),
            ],
            notes="A resume/CV rendered inside a PDF-viewer-shaped frame.",
        )
    )

    patient = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(
        rng.choices("abcdefghijklmnopqrstuvwxyz", k=7)
    )
    dob = f"{rng.randint(1,28):02d}-{rng.randint(1,12):02d}-19{rng.randint(60,99)}"
    local_patient = (80, 120, 220, 22)
    local_dob = (80, 150, 120, 22)
    box_patient = (frame_origin[0] + local_patient[0], frame_origin[1] + local_patient[1], local_patient[2], local_patient[3])
    box_dob = (frame_origin[0] + local_dob[0], frame_origin[1] + local_dob[1], local_dob[2], local_dob[3])
    fixtures.append(
        Fixture(
            "pdf-003", "health", "pdf", "Lab Report Viewer",
            '<div class="heading">Lab Report Viewer</div>'
            f'<div style="position:absolute;left:{frame_origin[0]}px;top:{frame_origin[1]}px;width:500px;height:600px;'
            'background:#fff;border:1px solid #999;box-shadow:0 0 8px rgba(0,0,0,0.15);">'
            '<div style="padding:20px;font-size:13px;color:#666;">Lab_Report.pdf — page 1 of 1</div>'
            + field_html("Patient name", patient, local_patient, "patient")
            + field_html("Date of birth", dob, local_dob, "dob")
            + "</div>",
            [
                LabelItem("PERSON_NAME", box_patient, sha256_hash(patient.lower())),
                LabelItem("DOB", box_dob, sha256_hash(dob)),
            ],
            notes="A lab report rendered inside a PDF-viewer-shaped frame; DOB has real label context.",
        )
    )

    pan_prefix3 = "".join(rng.choices("ABCDEFGHIJKLMNPQRSTUVWXYZ", k=3))
    pan_holder_type = rng.choice("ABCPFGHLTJ")
    pan_letter5 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan_digits = "".join(str(rng.randint(0, 9)) for _ in range(4))
    pan_letter2 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan = pan_prefix3 + pan_holder_type + pan_letter5 + pan_digits + pan_letter2
    addr = f"{rng.randint(1,999)} MG Road, Apartment {rng.randint(1,50)}, Bengaluru"
    local_pan = (80, 120, 120, 22)
    local_addr = (80, 150, 300, 22)
    box_pan = (frame_origin[0] + local_pan[0], frame_origin[1] + local_pan[1], local_pan[2], local_pan[3])
    box_addr = (frame_origin[0] + local_addr[0], frame_origin[1] + local_addr[1], local_addr[2], local_addr[3])
    fixtures.append(
        Fixture(
            "pdf-004", "docs", "pdf", "Property Deed Viewer",
            '<div class="heading">Property Deed Viewer</div>'
            f'<div style="position:absolute;left:{frame_origin[0]}px;top:{frame_origin[1]}px;width:500px;height:600px;'
            'background:#fff;border:1px solid #999;box-shadow:0 0 8px rgba(0,0,0,0.15);">'
            '<div style="padding:20px;font-size:13px;color:#666;">Property_Deed.pdf — page 1 of 1</div>'
            + field_html("PAN", pan, local_pan, "pan")
            + field_html("Registered address", addr, local_addr, "addr")
            + "</div>",
            [
                LabelItem("PAN", box_pan, sha256_hash(pan)),
                LabelItem("ADDRESS", box_addr, sha256_hash(addr.lower())),
            ],
            notes="A property deed rendered inside a PDF-viewer-shaped frame.",
        )
    )

    return fixtures


def build_health(rng: random.Random) -> list[Fixture]:
    """Healthcare category — named in phase_5_measurement.md §6's ten categories but entirely
    unrepresented before this corpus-growth pass (0 fixtures tagged `page.category: "health"`)."""
    fixtures = []

    name = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(
        rng.choices("abcdefghijklmnopqrstuvwxyz", k=6)
    ) + " " + "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(
        rng.choices("abcdefghijklmnopqrstuvwxyz", k=7)
    )
    dob = f"{rng.randint(1,28):02d}-{rng.randint(1,12):02d}-19{rng.randint(60,99)}"
    phone = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    name_box = (220, 120, 220, 24)
    dob_box = (220, 160, 120, 24)
    phone_box = (220, 200, 160, 24)
    fixtures.append(
        Fixture(
            "health-001", "health", "health", "Patient Health Record",
            '<div class="heading">Patient Health Record</div>'
            + field_html("Patient name", name, name_box, "name")
            + field_html("Date of birth", dob, dob_box, "dob")
            + field_html("Contact number", phone, phone_box, "phone"),
            [
                LabelItem("PERSON_NAME", name_box, sha256_hash(name.lower())),
                LabelItem("DOB", dob_box, sha256_hash(dob)),
                LabelItem("PHONE", phone_box, sha256_hash(phone.replace(" ", "").replace("+", ""))),
            ],
            notes="Patient record: name, DOB with label context, phone.",
        )
    )

    patient2 = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(
        rng.choices("abcdefghijklmnopqrstuvwxyz", k=7)
    )
    doctor = "Dr. " + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=7)).capitalize()
    box_patient = (16, 60, 240, 22)
    box_doctor = (16, 90, 240, 22)
    fixtures.append(
        Fixture(
            "health-002", "health", "health", "Pharmacy Prescription",
            f'<div id="patient" style="position:absolute;left:{box_patient[0]}px;top:{box_patient[1]}px;">'
            f"Patient: {patient2}</div>"
            f'<div id="doctor" style="position:absolute;left:{box_doctor[0]}px;top:{box_doctor[1]}px;">'
            f"Prescribed by: {doctor}</div>",
            [
                LabelItem("PERSON_NAME", box_patient, sha256_hash(patient2.lower())),
                LabelItem("PERSON_NAME", box_doctor, sha256_hash(doctor.lower())),
            ],
            notes="A prescription slip with two names in free text (patient and doctor).",
        )
    )

    name3 = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(
        rng.choices("abcdefghijklmnopqrstuvwxyz", k=6)
    )
    phone3 = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    dob3 = f"{rng.randint(1,28):02d}-{rng.randint(1,12):02d}-19{rng.randint(60,99)}"
    name3_box = (220, 120, 180, 24)
    phone3_box = (220, 160, 160, 24)
    dob3_box = (220, 200, 120, 24)
    fixtures.append(
        Fixture(
            "health-003", "health", "health", "Book an Appointment",
            '<div class="heading">Book an Appointment</div>'
            + field_html("Full name", name3, name3_box, "name")
            + field_html("Phone", phone3, phone3_box, "phone")
            + field_html("Date of birth", dob3, dob3_box, "dob"),
            [
                LabelItem("PERSON_NAME", name3_box, sha256_hash(name3.lower())),
                LabelItem("PHONE", phone3_box, sha256_hash(phone3.replace(" ", "").replace("+", ""))),
                LabelItem("DOB", dob3_box, sha256_hash(dob3)),
            ],
            notes="Appointment booking form: name, phone, DOB with label context.",
        )
    )

    box4 = (480, 260, 140, 140)
    fixtures.append(
        Fixture(
            "health-004", "health", "health", "Video Consultation",
            '<div class="heading">Video Consultation</div>'
            + f'<div id="self-preview" style="position:absolute;left:{box4[0]}px;top:{box4[1]}px;">'
              f'{_svg_placeholder("face", box4[2], box4[3])}</div>',
            [LabelItem("FACE", box4)],
            notes="Telemedicine video-call self-preview tile.",
        )
    )

    base5 = random_aadhaar_base(rng)
    aadhaar5 = base5 + verhoeff_generate(base5)
    account5 = "".join(str(rng.randint(0, 9)) for _ in range(rng.randint(9, 16)))
    ifsc5 = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=4)) + "0" + "".join(
        rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", k=6)
    )
    aadhaar5_box = (220, 120, 160, 22)
    account5_box = (220, 160, 180, 22)
    ifsc5_box = (220, 200, 130, 22)
    fixtures.append(
        Fixture(
            "health-005", "health", "health", "Insurance Claim",
            '<div class="heading">Insurance Claim</div>'
            + field_html("Aadhaar number", aadhaar5, aadhaar5_box, "aadhaar")
            + field_html("Bank account number", account5, account5_box, "account")
            + field_html("IFSC code", ifsc5, ifsc5_box, "ifsc"),
            [
                LabelItem("AADHAAR", aadhaar5_box, sha256_hash(aadhaar5)),
                LabelItem("BANK_ACCOUNT", account5_box, sha256_hash(account5), note="disclosed gap: no dedicated BANK_ACCOUNT pattern recognizer exists yet — expected FN, not a leak (Channel D/NER only)"),
                LabelItem("IFSC", ifsc5_box, sha256_hash(ifsc5)),
            ],
            notes="Insurance claim form; BANK_ACCOUNT has real label context but no client-side pattern recognizer (disclosed gap).",
        )
    )

    patient6 = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(
        rng.choices("abcdefghijklmnopqrstuvwxyz", k=6)
    )
    dob6 = f"{rng.randint(1,28):02d}-{rng.randint(1,12):02d}-19{rng.randint(60,99)}"
    frame_origin = (40, 60)
    local_patient6 = (80, 120, 200, 22)
    local_dob6 = (80, 150, 120, 22)
    box_patient6 = (frame_origin[0] + local_patient6[0], frame_origin[1] + local_patient6[1], local_patient6[2], local_patient6[3])
    box_dob6 = (frame_origin[0] + local_dob6[0], frame_origin[1] + local_dob6[1], local_dob6[2], local_dob6[3])
    fixtures.append(
        Fixture(
            "health-006", "health", "health", "Discharge Summary Viewer",
            '<div class="heading">Discharge Summary Viewer</div>'
            f'<div style="position:absolute;left:{frame_origin[0]}px;top:{frame_origin[1]}px;width:500px;height:600px;'
            'background:#fff;border:1px solid #999;box-shadow:0 0 8px rgba(0,0,0,0.15);">'
            '<div style="padding:20px;font-size:13px;color:#666;">Discharge_Summary.pdf — page 1 of 1</div>'
            + field_html("Patient name", patient6, local_patient6, "patient")
            + field_html("Date of birth", dob6, local_dob6, "dob")
            + "</div>",
            [
                LabelItem("PERSON_NAME", box_patient6, sha256_hash(patient6.lower())),
                LabelItem("DOB", box_dob6, sha256_hash(dob6)),
            ],
            notes="A discharge summary rendered inside a PDF-viewer-shaped frame; DOB has real label context.",
        )
    )

    return fixtures


def build_gov_extra(rng: random.Random) -> list[Fixture]:
    """More government-portal pages, including two entities the corpus had zero genuine positives
    for before this pass: PASSPORT and VEHICLE_REG."""
    fixtures = []

    name = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(
        rng.choices("abcdefghijklmnopqrstuvwxyz", k=6)
    )
    dob = f"{rng.randint(1,28):02d}-{rng.randint(1,12):02d}-19{rng.randint(60,99)}"
    phone = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    name_box = (220, 120, 180, 24)
    dob_box = (220, 160, 120, 24)
    phone_box = (220, 200, 160, 24)
    fixtures.append(
        Fixture(
            "gov-001", "gov", "gov", "Driving Licence Application",
            '<div class="heading">Driving Licence Application</div>'
            + field_html("Applicant name", name, name_box, "name")
            + field_html("Date of birth", dob, dob_box, "dob")
            + field_html("Phone", phone, phone_box, "phone"),
            [
                LabelItem("PERSON_NAME", name_box, sha256_hash(name.lower())),
                LabelItem("DOB", dob_box, sha256_hash(dob)),
                LabelItem("PHONE", phone_box, sha256_hash(phone.replace(" ", "").replace("+", ""))),
            ],
            notes="Driving licence application: name, DOB with label context, phone.",
        )
    )

    pan_prefix3 = "".join(rng.choices("ABCDEFGHIJKLMNPQRSTUVWXYZ", k=3))
    pan_holder_type = rng.choice("ABCPFGHLTJ")
    pan_letter5 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan_digits = "".join(str(rng.randint(0, 9)) for _ in range(4))
    pan_letter2 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan = pan_prefix3 + pan_holder_type + pan_letter5 + pan_digits + pan_letter2
    email = "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=9)) + "@example.test"
    pan_box = (220, 120, 120, 22)
    email_box = (220, 160, 220, 22)
    fixtures.append(
        Fixture(
            "gov-002", "gov", "gov", "Income Tax e-Filing",
            '<div class="heading">Income Tax e-Filing</div>'
            + field_html("PAN", pan, pan_box, "pan")
            + field_html("Registered email", email, email_box, "email"),
            [
                LabelItem("PAN", pan_box, sha256_hash(pan)),
                LabelItem("EMAIL", email_box, sha256_hash(email.lower())),
            ],
            notes="Income-tax e-filing portal: PAN with label context, email.",
        )
    )

    base = random_aadhaar_base(rng)
    aadhaar = base + verhoeff_generate(base)
    addr = f"{rng.randint(1,999)} MG Road, Apartment {rng.randint(1,50)}, Bengaluru"
    aadhaar_box = (220, 120, 160, 22)
    addr_box = (16, 160, 460, 22)
    fixtures.append(
        Fixture(
            "gov-003", "gov", "gov", "Ration Card Portal",
            '<div class="heading">Ration Card Portal</div>'
            + field_html("Aadhaar number", aadhaar, aadhaar_box, "aadhaar")
            + f'<div id="addr" style="position:absolute;left:{addr_box[0]}px;top:{addr_box[1]}px;">'
              f"Registered address: {addr}.</div>",
            [
                LabelItem("AADHAAR", aadhaar_box, sha256_hash(aadhaar)),
                LabelItem("ADDRESS", addr_box, sha256_hash(addr.lower())),
            ],
            notes="Ration card portal: Aadhaar with label context, address in free text.",
        )
    )

    passport_letter = rng.choice("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
    passport_digits = "".join(str(rng.randint(0, 9)) for _ in range(7))
    passport = passport_letter + passport_digits
    dob2 = f"{rng.randint(1,28):02d}-{rng.randint(1,12):02d}-19{rng.randint(60,99)}"
    passport_box = (220, 120, 120, 22)
    dob2_box = (220, 160, 120, 22)
    fixtures.append(
        Fixture(
            "gov-004", "gov", "gov", "Passport Application Status",
            '<div class="heading">Passport Application Status</div>'
            + field_html("Passport number", passport, passport_box, "passport")
            + field_html("Date of birth", dob2, dob2_box, "dob"),
            [
                LabelItem("PASSPORT", passport_box, sha256_hash(passport)),
                LabelItem("DOB", dob2_box, sha256_hash(dob2)),
            ],
            notes="Passport status page: PASSPORT with label context (the corpus's first genuine PASSPORT positive), DOB with label context.",
        )
    )

    vehicle_state = rng.choice(["KA", "MH", "DL", "TN", "UP", "GJ"])
    vehicle_reg = f"{vehicle_state}{rng.randint(1,99):02d} {rng.choice('ABCDEFGHJKLMNPQRSTUVWXYZ')}{rng.choice('ABCDEFGHJKLMNPQRSTUVWXYZ')} {rng.randint(1000,9999)}"
    name2 = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(
        rng.choices("abcdefghijklmnopqrstuvwxyz", k=6)
    )
    vehicle_box = (220, 120, 160, 22)
    name2_box = (220, 160, 180, 22)
    fixtures.append(
        Fixture(
            "gov-005", "gov", "gov", "Vehicle Insurance Renewal",
            '<div class="heading">Vehicle Insurance Renewal</div>'
            + field_html("Registration number", vehicle_reg, vehicle_box, "vehicle")
            + field_html("Owner name", name2, name2_box, "name"),
            [
                LabelItem("VEHICLE_REG", vehicle_box, sha256_hash(vehicle_reg)),
                LabelItem("PERSON_NAME", name2_box, sha256_hash(name2.lower())),
            ],
            notes="Vehicle insurance renewal: VEHICLE_REG with a real state code (the corpus's first genuine VEHICLE_REG positive), owner name.",
        )
    )

    return fixtures


def build_bank_extra(rng: random.Random) -> list[Fixture]:
    """More banking pages beyond `id-005..007`/`forms-001..003` — corpus growth pass. Deliberately
    exercises BANK_ACCOUNT (a labelled entity in the schema with no client-side pattern
    recognizer, a disclosed gap — see `packages/recognizers/src/context/lexicons.ts`)."""
    fixtures = []

    account = "".join(str(rng.randint(0, 9)) for _ in range(rng.randint(9, 16)))
    ifsc = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=4)) + "0" + "".join(
        rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", k=6)
    )
    phone = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    account_box = (220, 120, 180, 22)
    ifsc_box = (220, 160, 130, 22)
    phone_box = (220, 200, 160, 22)
    fixtures.append(
        Fixture(
            "bank-001", "banking", "bank", "Net Banking Dashboard",
            '<div class="heading">Net Banking Dashboard</div>'
            + field_html("Account number", account, account_box, "account")
            + field_html("IFSC code", ifsc, ifsc_box, "ifsc")
            + field_html("Registered phone", phone, phone_box, "phone"),
            [
                LabelItem("BANK_ACCOUNT", account_box, sha256_hash(account), note="disclosed gap: no dedicated BANK_ACCOUNT pattern recognizer yet — expected FN"),
                LabelItem("IFSC", ifsc_box, sha256_hash(ifsc)),
                LabelItem("PHONE", phone_box, sha256_hash(phone.replace(" ", "").replace("+", ""))),
            ],
            notes="Net-banking dashboard; BANK_ACCOUNT disclosed gap alongside a real IFSC catch.",
        )
    )

    account2 = "".join(str(rng.randint(0, 9)) for _ in range(rng.randint(9, 16)))
    pan_prefix3 = "".join(rng.choices("ABCDEFGHIJKLMNPQRSTUVWXYZ", k=3))
    pan_holder_type = rng.choice("ABCPFGHLTJ")
    pan_letter5 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan_digits = "".join(str(rng.randint(0, 9)) for _ in range(4))
    pan_letter2 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan = pan_prefix3 + pan_holder_type + pan_letter5 + pan_digits + pan_letter2
    account2_box = (220, 120, 180, 22)
    pan2_box = (220, 160, 120, 22)
    fixtures.append(
        Fixture(
            "bank-002", "banking", "bank", "Loan EMI Calculator",
            '<div class="heading">Loan EMI Calculator</div>'
            + field_html("Disbursement account", account2, account2_box, "account")
            + field_html("PAN", pan, pan2_box, "pan"),
            [
                LabelItem("BANK_ACCOUNT", account2_box, sha256_hash(account2), note="disclosed gap: no dedicated BANK_ACCOUNT pattern recognizer yet — expected FN"),
                LabelItem("PAN", pan2_box, sha256_hash(pan)),
            ],
            notes="Loan EMI calculator; BANK_ACCOUNT disclosed gap alongside a real PAN catch.",
        )
    )

    account3 = "".join(str(rng.randint(0, 9)) for _ in range(rng.randint(9, 16)))
    ifsc3 = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=4)) + "0" + "".join(
        rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", k=6)
    )
    sig_box = (220, 200, 200, 80)
    account3_box = (220, 120, 180, 22)
    ifsc3_box = (220, 160, 130, 22)
    fixtures.append(
        Fixture(
            "bank-003", "banking", "bank", "Cheque Deposit Slip",
            '<div class="heading">Cheque Deposit Slip</div>'
            + field_html("Account number", account3, account3_box, "account")
            + field_html("IFSC code", ifsc3, ifsc3_box, "ifsc")
            + f'<div id="signature-region" style="position:absolute;left:{sig_box[0]}px;top:{sig_box[1]}px;">'
              f'{_svg_placeholder("signature", sig_box[2], sig_box[3])}</div>',
            [
                LabelItem("BANK_ACCOUNT", account3_box, sha256_hash(account3), note="disclosed gap: no dedicated BANK_ACCOUNT pattern recognizer yet — expected FN"),
                LabelItem("IFSC", ifsc3_box, sha256_hash(ifsc3)),
                LabelItem("SIGNATURE", sig_box),
            ],
            notes="Cheque deposit slip; account/IFSC plus a placeholder signature graphic.",
        )
    )

    base4 = random_aadhaar_base(rng)
    aadhaar4 = base4 + verhoeff_generate(base4)
    pan_prefix3b = "".join(rng.choices("ABCDEFGHIJKLMNPQRSTUVWXYZ", k=3))
    pan_holder_typeb = rng.choice("ABCPFGHLTJ")
    pan_letter5b = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan_digitsb = "".join(str(rng.randint(0, 9)) for _ in range(4))
    pan_letter2b = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan4 = pan_prefix3b + pan_holder_typeb + pan_letter5b + pan_digitsb + pan_letter2b
    price = f"Rs. {rng.randint(10000, 999999):,}.00"
    aadhaar4_box = (220, 120, 160, 22)
    pan4_box = (220, 160, 120, 22)
    price_box = (220, 200, 140, 22)
    fixtures.append(
        Fixture(
            "bank-004", "banking", "bank", "Fixed Deposit Certificate",
            '<div class="heading">Fixed Deposit Certificate</div>'
            + field_html("Aadhaar number", aadhaar4, aadhaar4_box, "aadhaar")
            + field_html("PAN", pan4, pan4_box, "pan")
            + field_html("Maturity amount", price, price_box, "amount"),
            [
                LabelItem("AADHAAR", aadhaar4_box, sha256_hash(aadhaar4)),
                LabelItem("PAN", pan4_box, sha256_hash(pan4)),
                LabelItem("NONE", price_box, note="a maturity amount — LOW class, must pass through, not redacted"),
            ],
            notes="Fixed deposit certificate; Aadhaar and PAN genuine positives alongside a price hard negative.",
        )
    )

    return fixtures


def build_email_extra(rng: random.Random) -> list[Fixture]:
    """Email/chat category — `id-008` and `freetext-003` touch this lightly; this pass adds
    dedicated email-client-shaped pages."""
    fixtures = []

    sender1 = "Anita " + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=6)).capitalize()
    email1 = "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=8)) + "@example.test"
    sender2 = "Rahul " + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=6)).capitalize()
    email2 = "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=8)) + "@example.test"
    box_s1 = (16, 60, 200, 20)
    box_e1 = (240, 60, 240, 20)
    box_s2 = (16, 90, 200, 20)
    box_e2 = (240, 90, 240, 20)
    fixtures.append(
        Fixture(
            "email-001", "email", "email", "Inbox",
            f'<div id="s1" style="position:absolute;left:{box_s1[0]}px;top:{box_s1[1]}px;">{sender1}</div>'
            f'<div id="e1" style="position:absolute;left:{box_e1[0]}px;top:{box_e1[1]}px;">{email1}</div>'
            f'<div id="s2" style="position:absolute;left:{box_s2[0]}px;top:{box_s2[1]}px;">{sender2}</div>'
            f'<div id="e2" style="position:absolute;left:{box_e2[0]}px;top:{box_e2[1]}px;">{email2}</div>',
            [
                LabelItem("PERSON_NAME", box_s1, sha256_hash(sender1.lower())),
                LabelItem("EMAIL", box_e1, sha256_hash(email1.lower())),
                LabelItem("PERSON_NAME", box_s2, sha256_hash(sender2.lower())),
                LabelItem("EMAIL", box_e2, sha256_hash(email2.lower())),
            ],
            notes="An inbox list with two sender/email pairs in free text rows.",
        )
    )

    phone = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    addr = f"{rng.randint(1,999)} MG Road, Apartment {rng.randint(1,50)}, Bengaluru"
    box_phone = (16, 60, 340, 20)
    box_addr = (16, 90, 400, 20)
    fixtures.append(
        Fixture(
            "email-002", "email", "email", "Support Ticket Thread",
            f'<div id="msg1" style="position:absolute;left:{box_phone[0]}px;top:{box_phone[1]}px;">'
            f"You can reach me at {phone} anytime.</div>"
            f'<div id="msg2" style="position:absolute;left:{box_addr[0]}px;top:{box_addr[1]}px;">'
            f"Please ship it to {addr}.</div>",
            [
                LabelItem("PHONE", box_phone, sha256_hash(phone.replace(" ", "").replace("+", ""))),
                LabelItem("ADDRESS", box_addr, sha256_hash(addr.lower())),
            ],
            notes="A support-ticket message thread with a phone number and an address in prose.",
        )
    )

    return fixtures


def build_social_extra(rng: random.Random) -> list[Fixture]:
    """More social-category pages beyond `faces-001`/`freetext-001..002` — corpus growth pass."""
    fixtures = []

    seller = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(
        rng.choices("abcdefghijklmnopqrstuvwxyz", k=6)
    )
    phone = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    box_seller = (16, 60, 200, 20)
    box_phone = (16, 90, 300, 20)
    fixtures.append(
        Fixture(
            "social-001", "social", "social", "Marketplace Listing",
            f'<div id="seller" style="position:absolute;left:{box_seller[0]}px;top:{box_seller[1]}px;">'
            f"Sold by {seller}</div>"
            f'<div id="contact" style="position:absolute;left:{box_phone[0]}px;top:{box_phone[1]}px;">'
            f"Contact seller: {phone}</div>",
            [
                LabelItem("PERSON_NAME", box_seller, sha256_hash(seller.lower())),
                LabelItem("PHONE", box_phone, sha256_hash(phone.replace(" ", "").replace("+", ""))),
            ],
            notes="A marketplace listing with a seller name and phone number in prose.",
        )
    )

    name = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(
        rng.choices("abcdefghijklmnopqrstuvwxyz", k=5)
    )
    box_name = (16, 60, 160, 20)
    box_age = (16, 90, 100, 20)
    fixtures.append(
        Fixture(
            "social-002", "social", "social", "Dating Profile Card",
            f'<div id="name" style="position:absolute;left:{box_name[0]}px;top:{box_name[1]}px;">{name}</div>'
            f'<div id="age" style="position:absolute;left:{box_age[0]}px;top:{box_age[1]}px;">{rng.randint(21,45)}</div>',
            [
                LabelItem("PERSON_NAME", box_name, sha256_hash(name.lower())),
                LabelItem("NONE", box_age, note="a bare age number — must not be flagged as any identifier"),
            ],
            notes="A dating-profile card: real name alongside a bare age hard negative.",
        )
    )

    name2 = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(
        rng.choices("abcdefghijklmnopqrstuvwxyz", k=6)
    )
    email = "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=8)) + "@example.test"
    box_name2 = (16, 60, 200, 22)
    box_email2 = (16, 90, 240, 22)
    fixtures.append(
        Fixture(
            "social-003", "social", "social", "Professional Profile",
            f'<div id="name" style="position:absolute;left:{box_name2[0]}px;top:{box_name2[1]}px;">'
            f"{name2}, Product Manager</div>"
            f'<div id="email" style="position:absolute;left:{box_email2[0]}px;top:{box_email2[1]}px;">{email}</div>',
            [
                LabelItem("PERSON_NAME", box_name2, sha256_hash(name2.lower())),
                LabelItem("EMAIL", box_email2, sha256_hash(email.lower())),
            ],
            notes="A professional-network profile page with a name/title line and an email.",
        )
    )

    phone2 = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    box_comment = (16, 60, 340, 20)
    fixtures.append(
        Fixture(
            "social-004", "social", "social", "Comment Thread",
            f'<div id="comment" style="position:absolute;left:{box_comment[0]}px;top:{box_comment[1]}px;">'
            f"Text me on {phone2} if you're interested!</div>",
            [LabelItem("PHONE", box_comment, sha256_hash(phone2.replace(" ", "").replace("+", "")))],
            notes="A social-post comment with a phone number accidentally posted in public prose.",
        )
    )

    return fixtures


def plant_canaries(fixtures: list[Fixture], rng: random.Random) -> None:
    """Every fixture gets ≥1 unique high-entropy canary appended as a hidden marker (design.md
    §18.1). It never overlaps a labelled PII box, so it never interferes with metric scoring —
    its only job is to be searched for verbatim in a captured payload."""
    for i, fx in enumerate(fixtures):
        cid = canary(rng)
        y = 680  # bottom strip of the 720px viewport, clear of every fixture's content above
        box = (16, y, 260, 16)
        fx.body_html += (
            f'<div id="canary-{i}" style="position:absolute;left:{box[0]}px;top:{box[1]}px;'
            f'font-size:10px;color:#fff;">{cid}</div>'
        )
        fx.items.append(LabelItem("UNKNOWN_SENSITIVE", box, canary=True, canary_id=cid))


def generate_all(seed: int = 20260917) -> list[Fixture]:
    rng = random.Random(seed)
    fixtures: list[Fixture] = []
    fixtures += build_identifiers(rng)
    fixtures += build_hardneg(rng)
    fixtures += build_forms(rng)
    fixtures += build_faces(rng)
    fixtures += build_freetext(rng)
    fixtures += build_canvas(rng)
    fixtures += build_pdf(rng)
    fixtures += build_indic(rng)
    fixtures += build_indic_extra(rng)
    fixtures += build_faces_extra(rng)
    fixtures += build_canvas_extra(rng)
    fixtures += build_pdf_extra(rng)
    fixtures += build_health(rng)
    fixtures += build_gov_extra(rng)
    fixtures += build_bank_extra(rng)
    fixtures += build_email_extra(rng)
    fixtures += build_social_extra(rng)
    plant_canaries(fixtures, rng)
    return fixtures


def main() -> None:
    CORPUS_DEV.mkdir(parents=True, exist_ok=True)
    LABELS_DIR.mkdir(parents=True, exist_ok=True)
    fixtures = generate_all()
    for fx in fixtures:
        fx.write()
    groups: dict[str, int] = {}
    for fx in fixtures:
        groups[fx.group] = groups.get(fx.group, 0) + 1
    print(f"[generate_fixtures] wrote {len(fixtures)} fixtures: {groups}")


if __name__ == "__main__":
    main()

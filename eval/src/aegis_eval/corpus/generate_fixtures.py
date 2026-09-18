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
    base = "".join(str(rng.randint(0, 9)) for _ in range(11))
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
    base2 = "".join(str(rng.randint(0, 9)) for _ in range(11))
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
    base = "".join(str(rng.randint(0, 9)) for _ in range(11))
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
    rack_code = f"{rng.choice('AB')}{rng.randint(1,9)} {rng.choice('CD')}{rng.randint(1,9)} {rng.randint(1000,9999)}"
    box = (220, 120, 140, 22)
    fixtures.append(
        Fixture(
            "hardneg-007", "docs", "hardneg", "Warehouse Inventory",
            '<div class="heading">Warehouse Inventory</div>'
            + field_html("Rack code", rack_code, box, "rack"),
            [LabelItem("NONE", box, note="vehicle-registration-shaped rack code in a warehouse system, not a real vehicle plate")],
            notes="Hard negative: vehicle-reg-shaped but a rack location code.",
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
    base_k = "".join(str(rng.randint(0, 9)) for _ in range(11))
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
    base = "".join(str(rng.randint(0, 9)) for _ in range(11))
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
    base = "".join(str(rng.randint(0, 9)) for _ in range(11))
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
    base = "".join(str(rng.randint(0, 9)) for _ in range(11))
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

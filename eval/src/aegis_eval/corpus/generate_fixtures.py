"""
Generates the Phase-1 ~30-screen dev corpus (phase_1_contract_harness.md §5.3): writes
eval/corpus/dev/<screen_id>/{page/index.html, meta.json, screenshot.png-not-yet} and
eval/labels/<screen_id>.json for every fixture, deterministically (seeded), using the verified
checksum functions in checksums.py.

Every PII-bearing element is positioned with explicit inline `position:absolute; left/top/width/
height` CSS, in CSS pixels, so the label box in the JSON is exactly the rendered box by
construction — not measured after the fact. main() then re-measures every text value to its own
glyphs (value_boxes.py): a phone number inside a sentence is labelled as the number, not the
sentence. A spot-check against real Playwright-measured getBoundingClientRect() is run separately
(test_fixture_boxes_match_dom.py) to catch any box-model surprise this reasoning might have missed.

Run with: `uv run python -m aegis_eval.corpus.generate_fixtures` (or the venv-direct equivalent).
Idempotent: re-running overwrites existing fixture output byte-for-byte from the same inputs.
"""

from __future__ import annotations

import hashlib
import json
import random
import shutil
from dataclasses import dataclass, field
from pathlib import Path

from aegis_eval.corpus.checksums import gstin_generate, luhn_generate, verhoeff_generate, verhoeff_valid
from aegis_eval.corpus.value_boxes import print_totals, refine_labels

REPO_ROOT = Path(__file__).resolve().parents[4]
CORPUS_DEV = REPO_ROOT / "eval" / "corpus" / "dev"
CORPUS_HELDOUT = REPO_ROOT / "eval" / "corpus" / "heldout"
LABELS_DIR = REPO_ROOT / "eval" / "labels"


def is_heldout(screen_id: str) -> bool:
    """design.md §18.1/§18.4's 80/20 dev/held-out split (T-5.1/T-5.10). Assignment is a stable
    hash of the screen_id, not a seeded shuffle-then-slice of the fixture list: a hash is fixed
    per screen_id forever, so growing the corpus in a later pass (adding fixtures, never removing
    or renaming existing ones) never reshuffles which *existing* fixtures are held out — only the
    newly-added ones get freshly (and independently) assigned. A positional split (e.g. "last
    20%") would silently move fixtures between splits on every growth pass, which is exactly the
    "peeked at repeatedly... become a dev split" risk design.md §18.4 warns about, just from the
    generator's own churn rather than from a human re-running the held-out split itself."""
    digest = hashlib.sha256(screen_id.encode("utf-8")).hexdigest()
    return int(digest, 16) % 5 == 0

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


def random_bank_account(rng: random.Random) -> str:
    """9-16 random digits, avoiding two shapes that collide with a different real entity:
    exactly 10 digits starting 6-9 is indistinguishable from an Indian mobile number
    (`phone.ts`'s `INDIAN_MOBILE_RE`) — found for real via `bank-005`, a BANK_ACCOUNT fixture
    whose random value was correctly detected as PHONE, scoring as a false positive. Exactly 12
    digits starting 2-9 with a coincidentally-valid Verhoeff checksum (~1-in-10 chance whenever
    length is 12) is indistinguishable from a real Aadhaar — found for real via `gov-010`, whose
    random bank account was correctly detected as a SECOND AADHAAR alongside the fixture's real
    one. Both are real cross-entity shape collisions in random digit generation, not client bugs;
    steering away from them here (rather than banning realistic lengths outright) is the fix."""
    length = rng.randint(9, 16)
    digits = "".join(str(rng.randint(0, 9)) for _ in range(length))
    if length == 10 and digits[0] in "6789":
        digits = "1" + digits[1:]
    if length == 12 and digits[0] in "23456789" and verhoeff_valid(digits):
        digits = digits[:-1] + str((int(digits[-1]) + 1) % 10)
    return digits


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
        corpus_root = CORPUS_HELDOUT if is_heldout(self.screen_id) else CORPUS_DEV
        page_dir = corpus_root / self.screen_id / "page"
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
        (corpus_root / self.screen_id / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")

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


def field_html_input(label: str, value: str, box: tuple[int, int, int, int], value_id: str) -> str:
    """Like `field_html`, but a real `<label for>`-associated `<input>` instead of two unrelated
    `<div>`s. This is what actually gives Channel T's context-required recognizers (DOB, PASSPORT,
    PIN_CODE — `packages/recognizers/src/context/boost.ts`'s `scoreByContext` entities) a real
    `RecognizerContext.label` to match against: `builder.ts`'s `candidatesFromNodeValue` only
    builds context from an actual form field's own name/label/autocomplete
    (`fieldContext(node)`), never from a free-text run's nearby-but-unassociated sibling text
    (`candidatesFromTextRun` never builds a context at all — see docs/HISTORY.md's DOB findings).
    A `field_html()` div, however visually adjacent to its label, can never be a genuine positive
    for one of these entities; use this helper instead when a fixture is meant to actually
    exercise real detection rather than illustrate the disclosed no-context gap on purpose (as
    `forms-004`/`hardneg-005`'s DOB fixtures deliberately do)."""
    x, y, w, h = box
    return (
        f'<label for="{value_id}" class="field-label" style="left:{x}px;top:{y - 18}px;">{label}</label>'
        f'<input id="{value_id}" type="text" value="{value}" class="field-value" '
        f'style="position:absolute;left:{x}px;top:{y}px;width:{w}px;height:{h}px;">'
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

    # hardneg-008: [Corrected, corpus growth pass] originally built as a hard negative on the
    # assumption that an already-masked "XXXX XXXX 1234"-style display shouldn't be treated as
    # sensitive. It should: design.md §6.2's own table has a dedicated "Masked Aadhaar" row
    # (`XXXX XXXX 1234`-style, no validator, 0.70, "entity AADHAAR, partial") — a deliberate
    # recognized case, not an oversight to guard against. `aadhaar.ts`'s `MASKED_AADHAAR_RE`
    # correctly flags it; this fixture's `entity: NONE` ground truth was wrong since Phase 1,
    # surfaced for real only now because this pass finally checked metric 3's per-fixture
    # over-redaction detail instead of just its aggregate rate. Kept the screen_id (renumbering
    # every fixture after it is a larger, unrelated risk for no real benefit) but corrected the
    # entity and moved its semantic group to `identifiers`, matching what it actually is.
    masked = "XXXX XXXX " + "".join(str(rng.randint(0, 9)) for _ in range(4))
    box = (220, 120, 160, 22)
    fixtures.append(
        Fixture(
            "hardneg-008", "gov", "identifiers", "Account Summary",
            '<div class="heading">Account Summary</div>'
            + field_html("Aadhaar on file (masked)", masked, box, "masked_aadhaar"),
            [LabelItem("AADHAAR", box, sha256_hash(masked), note="masked display — design.md §6.2's dedicated Masked Aadhaar case (0.70, partial), a genuine positive, not a hard negative")],
            notes="A masked Aadhaar display, correctly detected via aadhaar.ts's dedicated MASKED_AADHAAR_RE — a genuine positive, not a hard negative (see the correction note above).",
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
    account5 = random_bank_account(rng)
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
            + field_html_input("Passport number", passport, passport_box, "passport")
            + field_html("Date of birth", dob2, dob2_box, "dob"),
            [
                LabelItem("PASSPORT", passport_box, sha256_hash(passport)),
                LabelItem("DOB", dob2_box, sha256_hash(dob2)),
            ],
            notes=(
                "Passport status page: PASSPORT via a real <label for>-associated <input> — the "
                "corpus's first genuine PASSPORT positive that can actually be detected (a plain "
                "field_html() div has no programmatic label association, so a context-required "
                "recognizer like PASSPORT's would always score below threshold regardless of "
                "visual proximity — see docs/HISTORY.md's DOB findings for why); DOB stays a "
                "field_html() div deliberately, to keep matching forms-004/hardneg-005's known, "
                "accepted no-context DOB gap rather than silently fixing it here too."
            ),
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

    account = random_bank_account(rng)
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

    account2 = random_bank_account(rng)
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

    account3 = random_bank_account(rng)
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

    box_group_1 = (16, 60, 200, 20)
    box_group_2 = (16, 90, 200, 20)
    name_a = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=5))
    name_b = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=5))
    fixtures.append(
        Fixture(
            "social-005", "social", "social", "Group Chat Roster",
            f'<div id="m1" style="position:absolute;left:{box_group_1[0]}px;top:{box_group_1[1]}px;">{name_a} joined the group</div>'
            f'<div id="m2" style="position:absolute;left:{box_group_2[0]}px;top:{box_group_2[1]}px;">{name_b} joined the group</div>',
            [
                LabelItem("PERSON_NAME", box_group_1, sha256_hash(name_a.lower())),
                LabelItem("PERSON_NAME", box_group_2, sha256_hash(name_b.lower())),
            ],
            notes="A group-chat system-message roster with two member names in free text.",
        )
    )

    return fixtures


def build_identifiers_extra(rng: random.Random) -> list[Fixture]:
    """More identifier-shaped pages beyond `id-001..008` — corpus growth pass. Exercises format
    variety design.md §6.2 documents but the original 8 never did: hyphen-grouped Aadhaar,
    international phone, and a non-Visa card network."""
    fixtures = []

    base = random_aadhaar_base(rng)
    aadhaar = base + verhoeff_generate(base)
    hyphen_grouped = f"{aadhaar[0:4]}-{aadhaar[4:8]}-{aadhaar[8:12]}"
    box = (220, 120, 160, 22)
    fixtures.append(
        Fixture(
            "id-009", "gov", "identifiers", "Aadhaar Download",
            '<div class="heading">Aadhaar Download</div>'
            + field_html("Aadhaar number", hyphen_grouped, box, "aadhaar"),
            [LabelItem("AADHAAR", box, sha256_hash(aadhaar))],
            notes="Fictitious Aadhaar, valid Verhoeff checksum, hyphen-grouped (design.md §6.2's other separator form, never exercised before).",
        )
    )

    intl_cc = rng.choice(["1", "44", "61", "971", "65"])
    intl_lengths = {"1": 10, "44": 10, "61": 9, "971": 9, "65": 8}
    national = "".join(str(rng.randint(0, 9)) for _ in range(intl_lengths[intl_cc]))
    intl_phone = f"+{intl_cc} {national}"
    box2 = (220, 120, 180, 22)
    fixtures.append(
        Fixture(
            "id-010", "email", "identifiers", "International Contact",
            '<div class="heading">International Contact</div>'
            + field_html("Phone", intl_phone, box2, "phone"),
            [LabelItem("PHONE", box2, sha256_hash(intl_phone.replace(" ", "").replace("+", "")))],
            notes=f"An E.164-like international phone number (+{intl_cc}), not an Indian mobile — exercises `phone.ts`'s separate `INTL_RE` path.",
        )
    )

    mc_prefix = rng.choice(["51", "52", "53", "54", "55"])
    mc_base = mc_prefix + "".join(str(rng.randint(0, 9)) for _ in range(13))
    mc_card = mc_base + luhn_generate(mc_base)
    mc_grouped = " ".join(mc_card[i : i + 4] for i in range(0, 16, 4))
    box3 = (220, 120, 190, 22)
    fixtures.append(
        Fixture(
            "id-011", "banking", "identifiers", "Wallet Top-up",
            '<div class="heading">Wallet Top-up</div>'
            + field_html("Card number", mc_grouped, box3, "card"),
            [LabelItem("CARD_NUMBER", box3, sha256_hash(mc_card))],
            notes="Fictitious card number, valid Luhn checksum, Mastercard-range IIN (not Visa, unlike id-007).",
        )
    )

    state2 = f"{rng.randint(1, 37):02d}"
    pan_prefix3 = "".join(rng.choices("ABCDEFGHIJKLMNPQRSTUVWXYZ", k=3))
    pan_holder_type = rng.choice("ABCPFGHLTJ")
    pan_letter5 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan_digits = "".join(str(rng.randint(0, 9)) for _ in range(4))
    pan_letter2 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan2 = pan_prefix3 + pan_holder_type + pan_letter5 + pan_digits + pan_letter2
    prefix14b = state2 + pan2 + "2" + "Z"
    check2 = gstin_generate(prefix14b)
    gstin2 = prefix14b + check2
    box4 = (220, 120, 170, 22)
    fixtures.append(
        Fixture(
            "id-012", "banking", "identifiers", "Vendor Onboarding",
            '<div class="heading">Vendor Onboarding</div>'
            + field_html("GSTIN", gstin2, box4, "gstin"),
            [LabelItem("GSTIN", box4, sha256_hash(gstin2))],
            notes="Fictitious GSTIN, valid check character, a different state code and entity-code digit from id-004.",
        )
    )

    state3 = f"{rng.randint(1, 37):02d}"
    pan_prefix3b = "".join(rng.choices("ABCDEFGHIJKLMNPQRSTUVWXYZ", k=3))
    pan_holder_typeb = rng.choice("ABCPFGHLTJ")
    pan_letter5b = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan_digitsb = "".join(str(rng.randint(0, 9)) for _ in range(4))
    pan_letter2b = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan3 = pan_prefix3b + pan_holder_typeb + pan_letter5b + pan_digitsb + pan_letter2b
    prefix14c = state3 + pan3 + "1" + "Z"
    real_check = gstin_generate(prefix14c)
    gstin_alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    wrong_check = gstin_alphabet[(gstin_alphabet.index(real_check) + 1) % 36]
    bad_gstin = prefix14c + wrong_check
    box5 = (220, 120, 170, 22)
    fixtures.append(
        Fixture(
            "id-013", "banking", "identifiers", "GST Verification",
            '<div class="heading">GST Verification</div>'
            + field_html("Entered GSTIN", bad_gstin, box5, "gstin"),
            [LabelItem("GSTIN", box5, sha256_hash(bad_gstin), note="checksum-invalid GSTIN; design.md §6.2 keeps this unverified-but-redacted (0.40), unlike PAN's hard reject — a genuine, lower-confidence positive")],
            notes="GSTIN-shaped with a deliberately wrong check character — moved here from hardneg after a real harness run showed this is NOT a hard negative: gstin.ts/design.md's own 0.40 invalid-checksum score keeps it in the unverified-but-redacted band.",
        )
    )

    return fixtures


def build_hardneg_extra2(rng: random.Random) -> list[Fixture]:
    """More hard negatives beyond `hardneg-001..012` — corpus growth pass. Each exercises a
    checksum/format-boundary case not yet covered.

    [Corrected before commit] This function originally included a "checksum-invalid GSTIN" hard
    negative (`entity: NONE`), built on the assumption that GSTIN behaves like PAN — an invalid
    checksum fully rejected. It doesn't: `gstin.ts` and design.md §6.2's own table (0.95 valid /
    0.40 invalid) deliberately keep a checksum-invalid-but-shape-valid GSTIN as an "unverified"
    HIGH-class region — still redacted, just at lower confidence — unlike `pan.ts`'s hard
    early-return on an invalid holder-type code. Confirmed via the real harness run: the client
    correctly redacted it (`unverified: true`, `confidence: 0.4`, exactly the documented value),
    which scored as a false positive against the wrongly-asserted `NONE` ground truth. This was a
    wrong fixture premise, not a client bug — moved to `build_identifiers_extra2` as a genuine
    (if unverified) GSTIN positive instead of staying here mislabelled as a hard negative."""
    fixtures = []

    low_entropy = "1" * rng.randint(24, 30)
    box2 = (220, 120, 220, 22)
    fixtures.append(
        Fixture(
            "hardneg-013", "docs", "hardneg", "Batch Job Log",
            '<div class="heading">Batch Job Log</div>'
            + field_html("Job ID", low_entropy, box2, "jobid"),
            [LabelItem("NONE", box2, note="a 24+ character token below the Shannon-entropy threshold — must not be flagged as SECRET")],
            notes="Hard negative: long token shape but low entropy (single repeated digit), below secret.ts's 3.5 threshold.",
        )
    )

    non_mobile = str(rng.randint(1, 5)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    box3 = (220, 120, 130, 22)
    fixtures.append(
        Fixture(
            "hardneg-014", "docs", "hardneg", "Asset Tag Lookup",
            '<div class="heading">Asset Tag Lookup</div>'
            + field_html("Asset tag", non_mobile, box3, "tag"),
            [LabelItem("NONE", box3, note="a 10-digit number starting 1-5 — not a valid Indian mobile prefix ([6-9]), must not be flagged as PHONE")],
            notes="Hard negative: 10-digit number, phone-length-shaped but not a valid mobile prefix.",
        )
    )

    # "XXXX XXXX 1234"-shaped masking deliberately avoided here: aadhaar.ts's MASKED_AADHAAR_RE
    # matches that exact shape regardless of what it's actually masking (see hardneg-008's
    # correction above, and this fixture's own first draft, which hit the identical collision in
    # the real harness run). "Ending in NNNN" phrasing has no digit-masking shape to collide with
    # — also a more realistic real-world bank-statement convention than literal X's.
    masked_account = "Ending in " + "".join(str(rng.randint(0, 9)) for _ in range(4))
    box4 = (220, 120, 180, 22)
    fixtures.append(
        Fixture(
            "hardneg-015", "banking", "hardneg", "Statement Summary",
            '<div class="heading">Statement Summary</div>'
            + field_html("Account", masked_account, box4, "masked_account"),
            [LabelItem("NONE", box4, note="already-masked account display ('Ending in NNNN') — no full value present to leak")],
            notes="Hard negative: pre-masked bank account display, not a full account number.",
        )
    )

    return fixtures


def build_upi_email_disambiguation(rng: random.Random) -> list[Fixture]:
    """A genuine EMAIL positive that is deliberately UPI-VPA-shaped (`name@handle`) but followed
    by a real TLD dot — `upi.ts`'s own disambiguation rule (design.md §6.2) means this must be
    classified as EMAIL, never UPI_VPA. Not a hard negative (it IS a real positive, just for a
    different entity than its shape might suggest) — no fixture exercised this disambiguation
    before this pass."""
    handle = "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=8))
    email = f"{handle}@gmail.com"
    box = (220, 120, 220, 22)
    return [
        Fixture(
            "email-003", "email", "email", "Newsletter Preferences",
            '<div class="heading">Newsletter Preferences</div>'
            + field_html("Email", email, box, "email"),
            [LabelItem("EMAIL", box, sha256_hash(email.lower()))],
            notes="UPI-VPA-shaped (name@handle) but followed by a real TLD dot — upi.ts's own rule means this is EMAIL, never UPI_VPA.",
        )
    ]


def build_email_extra2(rng: random.Random) -> list[Fixture]:
    fixtures = build_upi_email_disambiguation(rng)

    name = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=6))
    email2 = "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=8)) + "@example.test"
    phone = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    box_name = (16, 60, 200, 20)
    box_email = (16, 90, 240, 20)
    box_phone = (16, 120, 200, 20)
    fixtures.append(
        Fixture(
            "email-004", "email", "email", "Meeting Invite",
            f'<div id="name" style="position:absolute;left:{box_name[0]}px;top:{box_name[1]}px;">From: {name}</div>'
            f'<div id="email" style="position:absolute;left:{box_email[0]}px;top:{box_email[1]}px;">{email2}</div>'
            f'<div id="phone" style="position:absolute;left:{box_phone[0]}px;top:{box_phone[1]}px;">Dial-in: {phone}</div>',
            [
                LabelItem("PERSON_NAME", box_name, sha256_hash(name.lower())),
                LabelItem("EMAIL", box_email, sha256_hash(email2.lower())),
                LabelItem("PHONE", box_phone, sha256_hash(phone.replace(" ", "").replace("+", ""))),
            ],
            notes="A calendar meeting invite: organizer name, email, dial-in phone number.",
        )
    )

    return fixtures


def build_forms_extra(rng: random.Random) -> list[Fixture]:
    """More form pages beyond `forms-001..004` — corpus growth pass."""
    fixtures = []

    username = "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=9))
    email = "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=8)) + "@example.test"
    password_len = rng.randint(8, 14)
    user_box = (220, 120, 220, 28)
    email_box = (220, 160, 220, 28)
    pass_box = (220, 200, 220, 28)
    fixtures.append(
        Fixture(
            "forms-005", "social", "forms", "Create Account",
            '<div class="heading">Create Account</div>'
            + field_html("Username", username, user_box, "username")
            + field_html("Email", email, email_box, "email")
            + f'<div class="field-label" style="left:220px;top:182px;">Password</div>'
              f'<input id="password" type="password" value="{"x" * password_len}" '
              f'style="position:absolute;left:{pass_box[0]}px;top:{pass_box[1]}px;'
              f'width:{pass_box[2]}px;height:{pass_box[3]}px;">',
            [
                LabelItem("USERNAME", user_box, sha256_hash(username)),
                LabelItem("EMAIL", email_box, sha256_hash(email.lower())),
                LabelItem("PASSWORD", pass_box, note=None),
            ],
            notes="Sign-up form: username, email, password field (presence only, value never read).",
        )
    )

    email2 = "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=8)) + "@example.test"
    otp_box = (220, 160, 120, 28)
    email2_box = (220, 120, 220, 28)
    fixtures.append(
        Fixture(
            "forms-006", "banking", "forms", "Forgot Password",
            '<div class="heading">Forgot Password</div>'
            + field_html("Email", email2, email2_box, "email")
            + f'<div class="field-label" style="left:220px;top:142px;">Reset code</div>'
              f'<input id="otp" autocomplete="one-time-code" type="text" value="719284" '
              f'style="position:absolute;left:{otp_box[0]}px;top:{otp_box[1]}px;'
              f'width:{otp_box[2]}px;height:{otp_box[3]}px;">',
            [
                LabelItem("EMAIL", email2_box, sha256_hash(email2.lower())),
                LabelItem("OTP", otp_box),
            ],
            notes="Forgot-password flow: email, OTP field (presence only).",
        )
    )

    phone = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    phone_box = (220, 120, 180, 28)
    otp2_box = (220, 160, 120, 28)
    fixtures.append(
        Fixture(
            "forms-007", "social", "forms", "Two-Factor Setup",
            '<div class="heading">Two-Factor Setup</div>'
            + field_html("Phone", phone, phone_box, "phone")
            + f'<div class="field-label" style="left:220px;top:142px;">Verification code</div>'
              f'<input id="otp" autocomplete="one-time-code" type="text" value="305817" '
              f'style="position:absolute;left:{otp2_box[0]}px;top:{otp2_box[1]}px;'
              f'width:{otp2_box[2]}px;height:{otp2_box[3]}px;">',
            [
                LabelItem("PHONE", phone_box, sha256_hash(phone.replace(" ", "").replace("+", ""))),
                LabelItem("OTP", otp2_box),
            ],
            notes="Two-factor setup: phone, OTP field (presence only).",
        )
    )

    name = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=6))
    addr = f"{rng.randint(1,999)} MG Road, Apartment {rng.randint(1,50)}, Bengaluru"
    pincode = str(rng.randint(110000, 899999))
    phone2 = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    name_box = (220, 120, 200, 22)
    addr_box = (220, 160, 320, 22)
    pin_box = (220, 200, 100, 22)
    phone2_box = (220, 240, 160, 22)
    fixtures.append(
        Fixture(
            "forms-008", "social", "forms", "Shipping Address",
            '<div class="heading">Shipping Address</div>'
            + field_html("Full name", name, name_box, "name")
            + field_html("Address", addr, addr_box, "addr")
            + field_html("PIN code", pincode, pin_box, "pin")
            + field_html("Phone", phone2, phone2_box, "phone"),
            [
                LabelItem("PERSON_NAME", name_box, sha256_hash(name.lower())),
                LabelItem("ADDRESS", addr_box, sha256_hash(addr.lower())),
                LabelItem("NONE", pin_box, note="a real-shaped postal PIN code with address context — PIN_CODE is policy class LOW and is never redacted by design, even with context"),
                LabelItem("PHONE", phone2_box, sha256_hash(phone2.replace(" ", "").replace("+", ""))),
            ],
            notes="Shipping address form: name, address, PIN code (LOW-class pass-through by design), phone.",
        )
    )

    return fixtures


def build_faces_extra2(_rng: random.Random) -> list[Fixture]:
    """More vision-channel-shaped pages beyond `faces-001..007` — corpus growth pass. Placeholder
    SVGs only (design.md §17); real denominators for a still-disclosed Channel V gap, same
    justification as the extra DOB fixtures elsewhere in this pass."""
    fixtures = []

    box = (220, 120, 260, 160)
    fixtures.append(
        Fixture(
            "faces-008", "gov", "faces", "Driving Licence Scan",
            '<div class="heading">Driving Licence Scan</div>'
            + f'<div id="id-doc-region" style="position:absolute;left:{box[0]}px;top:{box[1]}px;">'
              f'{_svg_placeholder("id_document", box[2], box[3])}</div>',
            [LabelItem("ID_DOCUMENT", box)],
            notes="Placeholder driving-licence scan graphic, redacted whole without attempting to read it.",
        )
    )

    box2a = (220, 120, 200, 260)
    box2b = (260, 160, 100, 100)
    fixtures.append(
        Fixture(
            "faces-009", "gov", "faces", "Passport Photo Page",
            '<div class="heading">Passport Photo Page</div>'
            + f'<div id="id-doc-region" style="position:absolute;left:{box2a[0]}px;top:{box2a[1]}px;">'
              f'{_svg_placeholder("id_document", box2a[2], box2a[3])}</div>'
            + f'<div id="photo-region" style="position:absolute;left:{box2b[0]}px;top:{box2b[1]}px;">'
              f'{_svg_placeholder("face", box2b[2], box2b[3])}</div>',
            [LabelItem("ID_DOCUMENT", box2a), LabelItem("FACE", box2b)],
            notes="A passport photo-page scan: the whole page as ID_DOCUMENT, plus the embedded photo as a separate FACE region.",
        )
    )

    return fixtures


def build_canvas_extra2(_rng: random.Random) -> list[Fixture]:
    """More canvas-rendered pages beyond `canvas-001..003` — corpus growth pass."""
    box = (40, 154, 200, 22)
    canvas_js = """
<script>
  const c3 = document.getElementById('cv3');
  const ctx3 = c3.getContext('2d');
  ctx3.strokeStyle = '#222';
  ctx3.lineWidth = 3;
  ctx3.beginPath();
  ctx3.moveTo(20, 90);
  ctx3.quadraticCurveTo(60, 40, 100, 90);
  ctx3.quadraticCurveTo(140, 140, 180, 90);
  ctx3.stroke();
</script>
"""
    return [
        Fixture(
            "canvas-004", "canvas_app", "canvas", "Signature Pad",
            '<div class="heading">Signature Pad</div>'
            f'<canvas id="cv3" width="400" height="200" '
            f'style="position:absolute;left:20px;top:80px;border:1px solid #ccc;"></canvas>'
            + canvas_js,
            [LabelItem("SIGNATURE", box)],
            notes="Canvas-rendered signature stroke in a signature-pad-style app — DOM has no accessible representation.",
        )
    ]


def build_pdf_extra2(rng: random.Random) -> list[Fixture]:
    """More PDF-viewer-shaped pages beyond `pdf-001..004` — corpus growth pass."""
    fixtures = []
    frame_origin = (40, 60)

    account = random_bank_account(rng)
    ifsc = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=4)) + "0" + "".join(
        rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", k=6)
    )
    local_account = (80, 120, 200, 22)
    local_ifsc = (80, 150, 130, 22)
    box_account = (frame_origin[0] + local_account[0], frame_origin[1] + local_account[1], local_account[2], local_account[3])
    box_ifsc = (frame_origin[0] + local_ifsc[0], frame_origin[1] + local_ifsc[1], local_ifsc[2], local_ifsc[3])
    fixtures.append(
        Fixture(
            "pdf-005", "banking", "pdf", "Bank Statement Viewer",
            '<div class="heading">Bank Statement Viewer</div>'
            f'<div style="position:absolute;left:{frame_origin[0]}px;top:{frame_origin[1]}px;width:500px;height:600px;'
            'background:#fff;border:1px solid #999;box-shadow:0 0 8px rgba(0,0,0,0.15);">'
            '<div style="padding:20px;font-size:13px;color:#666;">Statement.pdf — page 1 of 1</div>'
            + field_html("Account number", account, local_account, "account")
            + field_html("IFSC code", ifsc, local_ifsc, "ifsc")
            + "</div>",
            [
                LabelItem("BANK_ACCOUNT", box_account, sha256_hash(account), note="disclosed gap: no dedicated BANK_ACCOUNT pattern recognizer yet — expected FN"),
                LabelItem("IFSC", box_ifsc, sha256_hash(ifsc)),
            ],
            notes="A bank statement rendered inside a PDF-viewer-shaped frame.",
        )
    )

    base2 = random_aadhaar_base(rng)
    aadhaar2 = base2 + verhoeff_generate(base2)
    pan_prefix3 = "".join(rng.choices("ABCDEFGHIJKLMNPQRSTUVWXYZ", k=3))
    pan_holder_type = rng.choice("ABCPFGHLTJ")
    pan_letter5 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan_digits = "".join(str(rng.randint(0, 9)) for _ in range(4))
    pan_letter2 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan = pan_prefix3 + pan_holder_type + pan_letter5 + pan_digits + pan_letter2
    local_aadhaar = (80, 120, 160, 22)
    local_pan = (80, 150, 120, 22)
    box_aadhaar = (frame_origin[0] + local_aadhaar[0], frame_origin[1] + local_aadhaar[1], local_aadhaar[2], local_aadhaar[3])
    box_pan = (frame_origin[0] + local_pan[0], frame_origin[1] + local_pan[1], local_pan[2], local_pan[3])
    fixtures.append(
        Fixture(
            "pdf-006", "banking", "pdf", "Insurance Policy Viewer",
            '<div class="heading">Insurance Policy Viewer</div>'
            f'<div style="position:absolute;left:{frame_origin[0]}px;top:{frame_origin[1]}px;width:500px;height:600px;'
            'background:#fff;border:1px solid #999;box-shadow:0 0 8px rgba(0,0,0,0.15);">'
            '<div style="padding:20px;font-size:13px;color:#666;">Policy.pdf — page 1 of 1</div>'
            + field_html("Aadhaar number", aadhaar2, local_aadhaar, "aadhaar")
            + field_html("PAN", pan, local_pan, "pan")
            + "</div>",
            [
                LabelItem("AADHAAR", box_aadhaar, sha256_hash(aadhaar2)),
                LabelItem("PAN", box_pan, sha256_hash(pan)),
            ],
            notes="An insurance policy document rendered inside a PDF-viewer-shaped frame.",
        )
    )

    name = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=6))
    dob = f"{rng.randint(1,28):02d}-{rng.randint(1,12):02d}-19{rng.randint(60,99)}"
    local_name = (80, 120, 200, 22)
    local_dob = (80, 150, 120, 22)
    box_name = (frame_origin[0] + local_name[0], frame_origin[1] + local_name[1], local_name[2], local_name[3])
    box_dob = (frame_origin[0] + local_dob[0], frame_origin[1] + local_dob[1], local_dob[2], local_dob[3])
    fixtures.append(
        Fixture(
            "pdf-007", "docs", "pdf", "Admit Card Viewer",
            '<div class="heading">Admit Card Viewer</div>'
            f'<div style="position:absolute;left:{frame_origin[0]}px;top:{frame_origin[1]}px;width:500px;height:600px;'
            'background:#fff;border:1px solid #999;box-shadow:0 0 8px rgba(0,0,0,0.15);">'
            '<div style="padding:20px;font-size:13px;color:#666;">Admit_Card.pdf — page 1 of 1</div>'
            + field_html("Candidate name", name, local_name, "name")
            + field_html("Date of birth", dob, local_dob, "dob")
            + "</div>",
            [
                LabelItem("PERSON_NAME", box_name, sha256_hash(name.lower())),
                LabelItem("DOB", box_dob, sha256_hash(dob)),
            ],
            notes="An exam admit card rendered inside a PDF-viewer-shaped frame; DOB stays a field_html() div (same accepted no-context gap).",
        )
    )

    return fixtures


def build_indic_extra2(rng: random.Random) -> list[Fixture]:
    """More Indic-script pages beyond `indic-001..004` — corpus growth pass. Five more scripts,
    each a distinct real content type (not all Aadhaar) per this document's own §16d lesson about
    not just re-using one template."""
    fixtures = []

    base = random_aadhaar_base(rng)
    aadhaar = base + verhoeff_generate(base)
    grouped = f"{aadhaar[0:4]} {aadhaar[4:8]} {aadhaar[8:12]}"
    box = (220, 120, 160, 24)
    fixtures.append(
        Fixture(
            "indic-005", "gov", "indic", "ಆಧಾರ್ ನೋಂದಣಿ ದೃಢೀಕರಣ",
            '<div class="heading">ಆಧಾರ್ ನೋಂದಣಿ ದೃಢೀಕರಣ</div>'
            + field_html("ಆಧಾರ್ ಸಂಖ್ಯೆ", grouped, box, "aadhaar"),
            [LabelItem("AADHAAR", box, sha256_hash(aadhaar))],
            notes="Kannada-script government portal; Aadhaar digits stay ASCII.",
            script="kannada",
        )
    )

    bank = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=4))
    ifsc = bank + "0" + "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", k=6))
    box2 = (220, 120, 140, 22)
    fixtures.append(
        Fixture(
            "indic-006", "banking", "indic", "శాఖ శోధన",
            '<div class="heading">శాఖ శోధన</div>'
            + field_html("ఐఎఫ్ఎస్‌సి కోడ్", ifsc, box2, "ifsc"),
            [LabelItem("IFSC", box2, sha256_hash(ifsc))],
            notes="Telugu-script banking form; fictitious IFSC, structurally valid.",
            script="telugu",
        )
    )

    name = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=6))
    phone = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    name_box = (220, 120, 200, 24)
    phone_box = (220, 160, 160, 24)
    fixtures.append(
        Fixture(
            "indic-007", "health", "indic", "દર્દીની નોંધણી",
            '<div class="heading">દર્દીની નોંધણી</div>'
            + field_html("દર્દીનું નામ", name, name_box, "name")
            + field_html("ફોન", phone, phone_box, "phone"),
            [
                LabelItem("PERSON_NAME", name_box, sha256_hash(name.lower())),
                LabelItem("PHONE", phone_box, sha256_hash(phone.replace(" ", "").replace("+", ""))),
            ],
            notes="Gujarati-script patient-registration form: name, phone.",
            script="gujarati",
        )
    )

    sender = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=5))
    email = "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=8)) + "@example.test"
    box_sender = (16, 60, 200, 20)
    box_email = (16, 90, 240, 20)
    fixtures.append(
        Fixture(
            "indic-008", "email", "indic", "ഇൻബോക്സ്",
            f'<div id="s" style="position:absolute;left:{box_sender[0]}px;top:{box_sender[1]}px;">{sender}</div>'
            f'<div id="e" style="position:absolute;left:{box_email[0]}px;top:{box_email[1]}px;">{email}</div>',
            [
                LabelItem("PERSON_NAME", box_sender, sha256_hash(sender.lower())),
                LabelItem("EMAIL", box_email, sha256_hash(email.lower())),
            ],
            notes="Malayalam-script email inbox row: sender name, email address.",
            script="malayalam",
        )
    )

    phone2 = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    box_post = (16, 60, 340, 22)
    fixtures.append(
        Fixture(
            "indic-009", "social", "indic", "ਪੋਸਟ",
            f'<div id="post" style="position:absolute;left:{box_post[0]}px;top:{box_post[1]}px;">'
            f"ਮੈਨੂੰ {phone2} ਤੇ ਕਾਲ ਕਰੋ</div>",
            [LabelItem("PHONE", box_post, sha256_hash(phone2.replace(" ", "").replace("+", "")))],
            notes="Punjabi-script social post with a phone number in prose.",
            script="punjabi",
        )
    )

    return fixtures


def build_health_extra(rng: random.Random) -> list[Fixture]:
    """More healthcare pages beyond `health-001..006` — corpus growth pass."""
    fixtures = []

    name = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=6))
    dob = f"{rng.randint(1,28):02d}-{rng.randint(1,12):02d}-20{rng.randint(0,20):02d}"
    name_box = (220, 120, 200, 24)
    dob_box = (220, 160, 120, 24)
    fixtures.append(
        Fixture(
            "health-007", "health", "health", "Vaccination Certificate",
            '<div class="heading">Vaccination Certificate</div>'
            + field_html("Beneficiary name", name, name_box, "name")
            + field_html("Date of birth", dob, dob_box, "dob"),
            [
                LabelItem("PERSON_NAME", name_box, sha256_hash(name.lower())),
                LabelItem("DOB", dob_box, sha256_hash(dob)),
            ],
            notes="Vaccination certificate: beneficiary name, DOB (field_html() div, same accepted no-context gap).",
        )
    )

    patient = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=6))
    phone = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    box_patient = (16, 60, 220, 20)
    box_msg = (16, 90, 400, 20)
    fixtures.append(
        Fixture(
            "health-008", "health", "health", "Telemedicine Chat",
            f'<div id="patient" style="position:absolute;left:{box_patient[0]}px;top:{box_patient[1]}px;">{patient}</div>'
            f'<div id="msg" style="position:absolute;left:{box_msg[0]}px;top:{box_msg[1]}px;">'
            f"You can reach me at {phone} for follow-up.</div>",
            [
                LabelItem("PERSON_NAME", box_patient, sha256_hash(patient.lower())),
                LabelItem("PHONE", box_msg, sha256_hash(phone.replace(" ", "").replace("+", ""))),
            ],
            notes="A telemedicine chat transcript with a patient name and phone number in prose.",
        )
    )

    name2 = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=6))
    phone2 = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    email = "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=8)) + "@example.test"
    name2_box = (220, 120, 200, 24)
    phone2_box = (220, 160, 160, 24)
    email_box = (220, 200, 220, 24)
    fixtures.append(
        Fixture(
            "health-009", "health", "health", "Dental Appointment Confirmation",
            '<div class="heading">Dental Appointment Confirmation</div>'
            + field_html("Patient name", name2, name2_box, "name")
            + field_html("Phone", phone2, phone2_box, "phone")
            + field_html("Email", email, email_box, "email"),
            [
                LabelItem("PERSON_NAME", name2_box, sha256_hash(name2.lower())),
                LabelItem("PHONE", phone2_box, sha256_hash(phone2.replace(" ", "").replace("+", ""))),
                LabelItem("EMAIL", email_box, sha256_hash(email.lower())),
            ],
            notes="Dental appointment confirmation: name, phone, email.",
        )
    )

    return fixtures


def build_gov_extra2(rng: random.Random) -> list[Fixture]:
    """More government-portal pages beyond `gov-001..005` — corpus growth pass."""
    fixtures = []

    base = random_aadhaar_base(rng)
    aadhaar = base + verhoeff_generate(base)
    otp_box = (220, 160, 120, 22)
    aadhaar_box = (220, 120, 160, 22)
    fixtures.append(
        Fixture(
            "gov-006", "gov", "gov", "Aadhaar-Mobile Linking",
            '<div class="heading">Aadhaar-Mobile Linking</div>'
            + field_html("Aadhaar number", aadhaar, aadhaar_box, "aadhaar")
            + f'<div class="field-label" style="left:220px;top:142px;">OTP</div>'
              f'<input id="otp" autocomplete="one-time-code" type="text" value="647210" '
              f'style="position:absolute;left:{otp_box[0]}px;top:{otp_box[1]}px;'
              f'width:{otp_box[2]}px;height:{otp_box[3]}px;">',
            [
                LabelItem("AADHAAR", aadhaar_box, sha256_hash(aadhaar)),
                LabelItem("OTP", otp_box),
            ],
            notes="Aadhaar-mobile linking flow: Aadhaar with label context, OTP field (presence only).",
        )
    )

    base2 = random_aadhaar_base(rng)
    aadhaar2 = base2 + verhoeff_generate(base2)
    pan_prefix3 = "".join(rng.choices("ABCDEFGHIJKLMNPQRSTUVWXYZ", k=3))
    pan_holder_type = rng.choice("ABCPFGHLTJ")
    pan_letter5 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan_digits = "".join(str(rng.randint(0, 9)) for _ in range(4))
    pan_letter2 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan = pan_prefix3 + pan_holder_type + pan_letter5 + pan_digits + pan_letter2
    aadhaar2_box = (220, 120, 160, 22)
    pan_box = (220, 160, 120, 22)
    fixtures.append(
        Fixture(
            "gov-007", "gov", "gov", "e-Sign Portal",
            '<div class="heading">e-Sign Portal</div>'
            + field_html("Aadhaar number", aadhaar2, aadhaar2_box, "aadhaar")
            + field_html("PAN", pan, pan_box, "pan"),
            [
                LabelItem("AADHAAR", aadhaar2_box, sha256_hash(aadhaar2)),
                LabelItem("PAN", pan_box, sha256_hash(pan)),
            ],
            notes="e-Sign identity-verification portal: Aadhaar and PAN, both with label context.",
        )
    )

    name = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=6))
    addr = f"{rng.randint(1,999)} MG Road, Apartment {rng.randint(1,50)}, Bengaluru"
    price = f"Rs. {rng.randint(1000, 99999):,}.00"
    name_box = (220, 120, 200, 22)
    addr_box = (16, 160, 460, 22)
    price_box = (220, 200, 140, 22)
    fixtures.append(
        Fixture(
            "gov-008", "gov", "gov", "Municipal Property Tax",
            '<div class="heading">Municipal Property Tax</div>'
            + field_html("Owner name", name, name_box, "name")
            + f'<div id="addr" style="position:absolute;left:{addr_box[0]}px;top:{addr_box[1]}px;">'
              f"Property address: {addr}.</div>"
            + field_html("Tax due", price, price_box, "amount"),
            [
                LabelItem("PERSON_NAME", name_box, sha256_hash(name.lower())),
                LabelItem("ADDRESS", addr_box, sha256_hash(addr.lower())),
                LabelItem("NONE", price_box, note="a tax amount — LOW class, must pass through, not redacted"),
            ],
            notes="Municipal property tax portal: owner name, address, tax amount hard negative.",
        )
    )

    return fixtures


def build_bank_extra2(rng: random.Random) -> list[Fixture]:
    """More banking pages beyond `bank-001..004` — corpus growth pass."""
    fixtures = []

    account = random_bank_account(rng)
    pan_prefix3 = "".join(rng.choices("ABCDEFGHIJKLMNPQRSTUVWXYZ", k=3))
    pan_holder_type = rng.choice("ABCPFGHLTJ")
    pan_letter5 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan_digits = "".join(str(rng.randint(0, 9)) for _ in range(4))
    pan_letter2 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan = pan_prefix3 + pan_holder_type + pan_letter5 + pan_digits + pan_letter2
    account_box = (220, 120, 180, 22)
    pan_box = (220, 160, 120, 22)
    fixtures.append(
        Fixture(
            "bank-005", "banking", "bank", "Demat Account Statement",
            '<div class="heading">Demat Account Statement</div>'
            + field_html("Linked account", account, account_box, "account")
            + field_html("PAN", pan, pan_box, "pan"),
            [
                LabelItem("BANK_ACCOUNT", account_box, sha256_hash(account), note="disclosed gap: no dedicated BANK_ACCOUNT pattern recognizer yet — expected FN"),
                LabelItem("PAN", pan_box, sha256_hash(pan)),
            ],
            notes="Demat account statement; BANK_ACCOUNT disclosed gap alongside a real PAN catch.",
        )
    )

    masked_card = "**** **** **** " + "".join(str(rng.randint(0, 9)) for _ in range(4))
    ifsc = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=4)) + "0" + "".join(
        rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", k=6)
    )
    card_box = (220, 120, 190, 22)
    ifsc_box = (220, 160, 130, 22)
    fixtures.append(
        Fixture(
            "bank-006", "banking", "bank", "Credit Card Statement",
            '<div class="heading">Credit Card Statement</div>'
            + field_html("Card on file", masked_card, card_box, "masked_card")
            + field_html("Linked branch IFSC", ifsc, ifsc_box, "ifsc"),
            [
                LabelItem("NONE", card_box, note="already-masked card display (12 digits hidden) — no full card number present to leak"),
                LabelItem("IFSC", ifsc_box, sha256_hash(ifsc)),
            ],
            notes="Credit card statement: a masked-card hard negative alongside a real IFSC catch.",
        )
    )

    account2 = random_bank_account(rng)
    ifsc2 = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=4)) + "0" + "".join(
        rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", k=6)
    )
    name = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=6))
    account2_box = (220, 120, 180, 22)
    ifsc2_box = (220, 160, 130, 22)
    name_box = (220, 200, 200, 22)
    fixtures.append(
        Fixture(
            "bank-007", "banking", "bank", "NEFT Transfer",
            '<div class="heading">NEFT Transfer</div>'
            + field_html("Beneficiary account", account2, account2_box, "account")
            + field_html("IFSC code", ifsc2, ifsc2_box, "ifsc")
            + field_html("Beneficiary name", name, name_box, "name"),
            [
                LabelItem("BANK_ACCOUNT", account2_box, sha256_hash(account2), note="disclosed gap: no dedicated BANK_ACCOUNT pattern recognizer yet — expected FN"),
                LabelItem("IFSC", ifsc2_box, sha256_hash(ifsc2)),
                LabelItem("PERSON_NAME", name_box, sha256_hash(name.lower())),
            ],
            notes="NEFT transfer form: account, IFSC, beneficiary name.",
        )
    )

    return fixtures


def build_freetext_extra(rng: random.Random) -> list[Fixture]:
    """More free-text pages beyond `freetext-001..003` — corpus growth pass."""
    fixtures = []

    name = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=6))
    handle = "@" + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=8))
    box_name = (16, 60, 200, 20)
    box_handle = (16, 90, 160, 20)
    fixtures.append(
        Fixture(
            "freetext-004", "social", "freetext", "Forum Bio",
            f'<div id="name" style="position:absolute;left:{box_name[0]}px;top:{box_name[1]}px;">{name}</div>'
            f'<div id="handle" style="position:absolute;left:{box_handle[0]}px;top:{box_handle[1]}px;">{handle}</div>',
            [
                LabelItem("PERSON_NAME", box_name, sha256_hash(name.lower())),
                LabelItem("USERNAME", box_handle, sha256_hash(handle)),
            ],
            notes="A forum profile bio: real name, @handle username (disclosed NER-only gap).",
        )
    )

    phone = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    box_ad = (16, 60, 540, 22)
    fixtures.append(
        Fixture(
            "freetext-005", "social", "freetext", "Classified Ad",
            f'<div id="ad" style="position:absolute;left:{box_ad[0]}px;top:{box_ad[1]}px;">'
            f"Selling bicycle, good condition. Call {phone} to arrange pickup.</div>",
            [LabelItem("PHONE", box_ad, sha256_hash(phone.replace(" ", "").replace("+", "")))],
            notes="A classified ad with a phone number in prose.",
        )
    )

    name2 = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=6))
    email = "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=8)) + "@example.test"
    box_name2 = (16, 60, 200, 20)
    box_email2 = (16, 90, 240, 20)
    fixtures.append(
        Fixture(
            "freetext-006", "social", "freetext", "Restaurant Review",
            f'<div id="reviewer" style="position:absolute;left:{box_name2[0]}px;top:{box_name2[1]}px;">'
            f"Reviewed by {name2}</div>"
            f'<div id="contact" style="position:absolute;left:{box_email2[0]}px;top:{box_email2[1]}px;">'
            f"Reply to {email}</div>",
            [
                LabelItem("PERSON_NAME", box_name2, sha256_hash(name2.lower())),
                LabelItem("EMAIL", box_email2, sha256_hash(email.lower())),
            ],
            notes="A restaurant review with reviewer name and reply email in prose.",
        )
    )

    name3 = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=6))
    phone2 = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    box_testimonial = (16, 60, 420, 22)
    box_name3 = (16, 90, 200, 20)
    fixtures.append(
        Fixture(
            "freetext-007", "social", "freetext", "Customer Testimonial",
            f'<div id="quote" style="position:absolute;left:{box_testimonial[0]}px;top:{box_testimonial[1]}px;">'
            f"Great service, reach them at {phone2} anytime.</div>"
            f'<div id="name" style="position:absolute;left:{box_name3[0]}px;top:{box_name3[1]}px;">— {name3}</div>',
            [
                LabelItem("PHONE", box_testimonial, sha256_hash(phone2.replace(" ", "").replace("+", ""))),
                LabelItem("PERSON_NAME", box_name3, sha256_hash(name3.lower())),
            ],
            notes="A customer testimonial with a phone number and the reviewer's name in prose.",
        )
    )

    return fixtures


def build_hardneg_extra3(rng: random.Random) -> list[Fixture]:
    """More hard negatives beyond `hardneg-001..015` — corpus growth pass."""
    fixtures = []

    # Deliberately rendered ungrouped (no spaces), not 4-4-4-4 like the other card fixtures: with
    # spacing, a random 16-digit run has ~5 candidate 12-digit windows any of which can
    # coincidentally form a word-boundary-delimited, Verhoeff-valid Aadhaar shape (found for real:
    # the first version of this fixture did exactly that, becoming a spurious AADHAAR match).
    # Kept as one unbroken digit token, no internal `\b` exists for `aadhaar.ts`'s regex to anchor
    # a sub-match to, regardless of digit content — a structural fix, not a lucky reroll.
    bad_iin_base = "9" + "".join(str(rng.randint(0, 9)) for _ in range(14))
    bad_iin_card = bad_iin_base + luhn_generate(bad_iin_base)
    box = (220, 120, 190, 22)
    fixtures.append(
        Fixture(
            "hardneg-016", "banking", "hardneg", "Loyalty Card Lookup",
            '<div class="heading">Loyalty Card Lookup</div>'
            + field_html("Card number", bad_iin_card, box, "card"),
            [LabelItem("NONE", box, note="16 digits, valid Luhn checksum, but no real card network's IIN prefix — must not be flagged as CARD_NUMBER")],
            notes="Hard negative: card-shaped and Luhn-valid, but fails the IIN-range check (card.ts requires both).",
        )
    )

    amex_base = rng.choice(["34", "37"]) + "".join(str(rng.randint(0, 9)) for _ in range(12))
    valid_amex_check = luhn_generate(amex_base)
    bad_amex = amex_base + str((int(valid_amex_check) + 1) % 10)
    bad_amex_grouped = f"{bad_amex[0:4]} {bad_amex[4:10]} {bad_amex[10:15]}"
    box2 = (220, 120, 170, 22)
    fixtures.append(
        Fixture(
            "hardneg-017", "banking", "hardneg", "Expense Reimbursement",
            '<div class="heading">Expense Reimbursement</div>'
            + field_html("Card number", bad_amex_grouped, box2, "card"),
            [LabelItem("NONE", box2, note="15 digits, Amex-range IIN prefix, but deliberately Luhn-invalid — must not be flagged as CARD_NUMBER")],
            notes="Hard negative: Amex-shaped (34/37 prefix, 15 digits) but Luhn-invalid.",
        )
    )

    return fixtures


def build_identifiers_extra3(rng: random.Random) -> list[Fixture]:
    """More identifier-shaped pages beyond `id-001..013` — corpus growth pass. Two more real card
    networks `id-007`/`id-011` never exercised."""
    fixtures = []

    amex_base = rng.choice(["34", "37"]) + "".join(str(rng.randint(0, 9)) for _ in range(12))
    amex_card = amex_base + luhn_generate(amex_base)
    amex_grouped = f"{amex_card[0:4]} {amex_card[4:10]} {amex_card[10:15]}"
    box = (220, 120, 170, 22)
    fixtures.append(
        Fixture(
            "id-014", "banking", "identifiers", "Travel Booking Payment",
            '<div class="heading">Travel Booking Payment</div>'
            + field_html("Card number", amex_grouped, box, "card"),
            [LabelItem("CARD_NUMBER", box, sha256_hash(amex_card))],
            notes="Fictitious card number, valid Luhn checksum, American Express-range IIN (15 digits, not 16).",
        )
    )

    rupay_prefix = rng.choice(["60", "65", "81", "82"])
    rupay_base = rupay_prefix + "".join(str(rng.randint(0, 9)) for _ in range(13))
    rupay_card = rupay_base + luhn_generate(rupay_base)
    rupay_grouped = " ".join(rupay_card[i : i + 4] for i in range(0, 16, 4))
    box2 = (220, 120, 190, 22)
    fixtures.append(
        Fixture(
            "id-015", "banking", "identifiers", "Merchant Payout",
            '<div class="heading">Merchant Payout</div>'
            + field_html("Card number", rupay_grouped, box2, "card"),
            [LabelItem("CARD_NUMBER", box2, sha256_hash(rupay_card))],
            notes="Fictitious card number, valid Luhn checksum, RuPay-range IIN.",
        )
    )

    return fixtures


def build_canvas_extra3(rng: random.Random) -> list[Fixture]:
    """More canvas-rendered pages beyond `canvas-001..004` — corpus growth pass."""
    fixtures = []

    pan_prefix3 = "".join(rng.choices("ABCDEFGHIJKLMNPQRSTUVWXYZ", k=3))
    pan_holder_type = rng.choice("ABCPFGHLTJ")
    pan_letter5 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan_digits = "".join(str(rng.randint(0, 9)) for _ in range(4))
    pan_letter2 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan = pan_prefix3 + pan_holder_type + pan_letter5 + pan_digits + pan_letter2
    box = (40, 154, 140, 22)
    canvas_js = f"""
<script>
  const c4 = document.getElementById('cv4');
  const ctx4 = c4.getContext('2d');
  ctx4.font = '16px sans-serif';
  ctx4.fillStyle = '#111';
  ctx4.fillText('PAN reference:', 20, 60);
  ctx4.font = 'bold 16px sans-serif';
  ctx4.fillText('{pan}', 20, 90);
</script>
"""
    fixtures.append(
        Fixture(
            "canvas-005", "canvas_app", "canvas", "Note-Taking App",
            '<div class="heading">Note-Taking App</div>'
            f'<canvas id="cv4" width="400" height="200" '
            f'style="position:absolute;left:20px;top:80px;border:1px solid #ccc;"></canvas>'
            + canvas_js,
            [LabelItem("PAN", box, sha256_hash(pan))],
            notes="Canvas-rendered PAN in a note-taking-app-style page — DOM has no accessible text.",
        )
    )

    phone = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    box2 = (40, 154, 200, 22)
    canvas_js2 = f"""
<script>
  const c5 = document.getElementById('cv5');
  const ctx5 = c5.getContext('2d');
  ctx5.font = '16px sans-serif';
  ctx5.fillStyle = '#111';
  ctx5.fillText('Top player contact:', 20, 60);
  ctx5.font = 'bold 16px sans-serif';
  ctx5.fillText('{phone}', 20, 90);
</script>
"""
    fixtures.append(
        Fixture(
            "canvas-006", "canvas_app", "canvas", "Game Leaderboard",
            '<div class="heading">Game Leaderboard</div>'
            f'<canvas id="cv5" width="400" height="200" '
            f'style="position:absolute;left:20px;top:80px;border:1px solid #ccc;"></canvas>'
            + canvas_js2,
            [LabelItem("PHONE", box2, sha256_hash(phone.replace(" ", "").replace("+", "")))],
            notes="Canvas-rendered phone number in a game-leaderboard-style page — DOM has no accessible text.",
        )
    )

    return fixtures


def build_pdf_extra3(rng: random.Random) -> list[Fixture]:
    """More PDF-viewer-shaped pages beyond `pdf-001..007` — corpus growth pass."""
    fixtures = []
    frame_origin = (40, 60)

    pan_prefix3 = "".join(rng.choices("ABCDEFGHIJKLMNPQRSTUVWXYZ", k=3))
    pan_holder_type = rng.choice("ABCPFGHLTJ")
    pan_letter5 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan_digits = "".join(str(rng.randint(0, 9)) for _ in range(4))
    pan_letter2 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan = pan_prefix3 + pan_holder_type + pan_letter5 + pan_digits + pan_letter2
    addr = f"{rng.randint(1,999)} MG Road, Apartment {rng.randint(1,50)}, Bengaluru"
    local_pan = (80, 120, 120, 22)
    local_addr = (80, 150, 320, 22)
    box_pan = (frame_origin[0] + local_pan[0], frame_origin[1] + local_pan[1], local_pan[2], local_pan[3])
    box_addr = (frame_origin[0] + local_addr[0], frame_origin[1] + local_addr[1], local_addr[2], local_addr[3])
    fixtures.append(
        Fixture(
            "pdf-008", "docs", "pdf", "Rental Agreement Viewer",
            '<div class="heading">Rental Agreement Viewer</div>'
            f'<div style="position:absolute;left:{frame_origin[0]}px;top:{frame_origin[1]}px;width:500px;height:600px;'
            'background:#fff;border:1px solid #999;box-shadow:0 0 8px rgba(0,0,0,0.15);">'
            '<div style="padding:20px;font-size:13px;color:#666;">Rental_Agreement.pdf — page 1 of 1</div>'
            + field_html("Tenant PAN", pan, local_pan, "pan")
            + field_html("Property address", addr, local_addr, "addr")
            + "</div>",
            [
                LabelItem("PAN", box_pan, sha256_hash(pan)),
                LabelItem("ADDRESS", box_addr, sha256_hash(addr.lower())),
            ],
            notes="A rental agreement rendered inside a PDF-viewer-shaped frame.",
        )
    )

    pan2_prefix3 = "".join(rng.choices("ABCDEFGHIJKLMNPQRSTUVWXYZ", k=3))
    pan2_holder_type = rng.choice("ABCPFGHLTJ")
    pan2_letter5 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan2_digits = "".join(str(rng.randint(0, 9)) for _ in range(4))
    pan2_letter2 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan2 = pan2_prefix3 + pan2_holder_type + pan2_letter5 + pan2_digits + pan2_letter2
    account = random_bank_account(rng)
    local_pan2 = (80, 120, 120, 22)
    local_account = (80, 150, 200, 22)
    box_pan2 = (frame_origin[0] + local_pan2[0], frame_origin[1] + local_pan2[1], local_pan2[2], local_pan2[3])
    box_account = (frame_origin[0] + local_account[0], frame_origin[1] + local_account[1], local_account[2], local_account[3])
    fixtures.append(
        Fixture(
            "pdf-009", "banking", "pdf", "Salary Slip Viewer",
            '<div class="heading">Salary Slip Viewer</div>'
            f'<div style="position:absolute;left:{frame_origin[0]}px;top:{frame_origin[1]}px;width:500px;height:600px;'
            'background:#fff;border:1px solid #999;box-shadow:0 0 8px rgba(0,0,0,0.15);">'
            '<div style="padding:20px;font-size:13px;color:#666;">Salary_Slip.pdf — page 1 of 1</div>'
            + field_html("PAN", pan2, local_pan2, "pan")
            + field_html("Bank account", account, local_account, "account")
            + "</div>",
            [
                LabelItem("PAN", box_pan2, sha256_hash(pan2)),
                LabelItem("BANK_ACCOUNT", box_account, sha256_hash(account), note="disclosed gap: no dedicated BANK_ACCOUNT pattern recognizer yet — expected FN"),
            ],
            notes="A salary slip rendered inside a PDF-viewer-shaped frame.",
        )
    )

    name = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=6))
    addr2 = f"{rng.randint(1,999)} MG Road, Apartment {rng.randint(1,50)}, Bengaluru"
    local_name = (80, 120, 200, 22)
    local_addr2 = (80, 150, 320, 22)
    box_name = (frame_origin[0] + local_name[0], frame_origin[1] + local_name[1], local_name[2], local_name[3])
    box_addr2 = (frame_origin[0] + local_addr2[0], frame_origin[1] + local_addr2[1], local_addr2[2], local_addr2[3])
    fixtures.append(
        Fixture(
            "pdf-010", "docs", "pdf", "Utility Bill Viewer",
            '<div class="heading">Utility Bill Viewer</div>'
            f'<div style="position:absolute;left:{frame_origin[0]}px;top:{frame_origin[1]}px;width:500px;height:600px;'
            'background:#fff;border:1px solid #999;box-shadow:0 0 8px rgba(0,0,0,0.15);">'
            '<div style="padding:20px;font-size:13px;color:#666;">Utility_Bill.pdf — page 1 of 1</div>'
            + field_html("Account holder", name, local_name, "name")
            + field_html("Billing address", addr2, local_addr2, "addr")
            + "</div>",
            [
                LabelItem("PERSON_NAME", box_name, sha256_hash(name.lower())),
                LabelItem("ADDRESS", box_addr2, sha256_hash(addr2.lower())),
            ],
            notes="A utility bill rendered inside a PDF-viewer-shaped frame.",
        )
    )

    return fixtures


def build_social_extra3(rng: random.Random) -> list[Fixture]:
    """More social-category pages beyond `social-001..005` — corpus growth pass."""
    fixtures = []

    seller = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=6))
    email = "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=8)) + "@example.test"
    box_seller = (16, 60, 200, 20)
    box_email = (16, 90, 240, 20)
    fixtures.append(
        Fixture(
            "social-006", "social", "social", "Resale Listing",
            f'<div id="seller" style="position:absolute;left:{box_seller[0]}px;top:{box_seller[1]}px;">Listed by {seller}</div>'
            f'<div id="email" style="position:absolute;left:{box_email[0]}px;top:{box_email[1]}px;">Email: {email}</div>',
            [
                LabelItem("PERSON_NAME", box_seller, sha256_hash(seller.lower())),
                LabelItem("EMAIL", box_email, sha256_hash(email.lower())),
            ],
            notes="A resale listing with seller name and email in prose.",
        )
    )

    name = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=6))
    phone = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    box_name = (16, 60, 200, 20)
    box_msg = (16, 90, 340, 20)
    fixtures.append(
        Fixture(
            "social-007", "social", "social", "Community Forum Thread",
            f'<div id="name" style="position:absolute;left:{box_name[0]}px;top:{box_name[1]}px;">{name} wrote:</div>'
            f'<div id="msg" style="position:absolute;left:{box_msg[0]}px;top:{box_msg[1]}px;">'
            f"DM me or call {phone} if interested.</div>",
            [
                LabelItem("PERSON_NAME", box_name, sha256_hash(name.lower())),
                LabelItem("PHONE", box_msg, sha256_hash(phone.replace(" ", "").replace("+", ""))),
            ],
            notes="A community forum post with an author name and a phone number in prose.",
        )
    )

    name2 = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=5))
    box_chat1 = (16, 60, 200, 20)
    box_chat2 = (16, 90, 200, 20)
    fixtures.append(
        Fixture(
            "social-008", "social", "social", "Dating Chat",
            f'<div id="msg1" style="position:absolute;left:{box_chat1[0]}px;top:{box_chat1[1]}px;">Hi, I am {name2}!</div>'
            f'<div id="msg2" style="position:absolute;left:{box_chat2[0]}px;top:{box_chat2[1]}px;">Nice to meet you too</div>',
            [LabelItem("PERSON_NAME", box_chat1, sha256_hash(name2.lower()))],
            notes="A dating-app chat transcript with a name in the first message.",
        )
    )

    return fixtures


def build_email_extra3(rng: random.Random) -> list[Fixture]:
    """More email pages beyond `email-001..004` — corpus growth pass."""
    fixtures = []

    email = "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=8)) + "@example.test"
    box = (220, 120, 240, 22)
    fixtures.append(
        Fixture(
            "email-005", "email", "email", "Password Reset Confirmation",
            '<div class="heading">Password Reset Confirmation</div>'
            + field_html("Sent to", email, box, "email"),
            [LabelItem("EMAIL", box, sha256_hash(email.lower()))],
            notes="A password-reset confirmation notice with the recipient email.",
        )
    )

    name = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=6))
    addr = f"{rng.randint(1,999)} MG Road, Apartment {rng.randint(1,50)}, Bengaluru"
    box_name = (16, 60, 200, 20)
    box_addr = (16, 90, 510, 20)
    fixtures.append(
        Fixture(
            "email-006", "email", "email", "Order Shipped Notification",
            f'<div id="name" style="position:absolute;left:{box_name[0]}px;top:{box_name[1]}px;">Hi {name},</div>'
            f'<div id="addr" style="position:absolute;left:{box_addr[0]}px;top:{box_addr[1]}px;">'
            f"Your order is on its way to {addr}.</div>",
            [
                LabelItem("PERSON_NAME", box_name, sha256_hash(name.lower())),
                LabelItem("ADDRESS", box_addr, sha256_hash(addr.lower())),
            ],
            notes="An order-shipped email notification with recipient name and shipping address.",
        )
    )

    return fixtures


def build_bank_extra3(rng: random.Random) -> list[Fixture]:
    """More banking pages beyond `bank-001..007` — corpus growth pass."""
    fixtures = []

    base = random_aadhaar_base(rng)
    aadhaar = base + verhoeff_generate(base)
    pan_prefix3 = "".join(rng.choices("ABCDEFGHIJKLMNPQRSTUVWXYZ", k=3))
    pan_holder_type = rng.choice("ABCPFGHLTJ")
    pan_letter5 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan_digits = "".join(str(rng.randint(0, 9)) for _ in range(4))
    pan_letter2 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan = pan_prefix3 + pan_holder_type + pan_letter5 + pan_digits + pan_letter2
    aadhaar_box = (220, 120, 160, 22)
    pan_box = (220, 160, 120, 22)
    fixtures.append(
        Fixture(
            "bank-008", "banking", "bank", "Fixed Deposit Renewal",
            '<div class="heading">Fixed Deposit Renewal</div>'
            + field_html("Aadhaar number", aadhaar, aadhaar_box, "aadhaar")
            + field_html("PAN", pan, pan_box, "pan"),
            [
                LabelItem("AADHAAR", aadhaar_box, sha256_hash(aadhaar)),
                LabelItem("PAN", pan_box, sha256_hash(pan)),
            ],
            notes="Fixed deposit renewal form: Aadhaar and PAN, both with label context.",
        )
    )

    account = random_bank_account(rng)
    ifsc = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=4)) + "0" + "".join(
        rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", k=6)
    )
    account_box = (220, 120, 180, 22)
    ifsc_box = (220, 160, 130, 22)
    fixtures.append(
        Fixture(
            "bank-009", "banking", "bank", "Standing Instruction Setup",
            '<div class="heading">Standing Instruction Setup</div>'
            + field_html("Debit account", account, account_box, "account")
            + field_html("Beneficiary IFSC", ifsc, ifsc_box, "ifsc"),
            [
                LabelItem("BANK_ACCOUNT", account_box, sha256_hash(account), note="disclosed gap: no dedicated BANK_ACCOUNT pattern recognizer yet — expected FN"),
                LabelItem("IFSC", ifsc_box, sha256_hash(ifsc)),
            ],
            notes="Standing instruction setup: account (disclosed gap), IFSC.",
        )
    )

    return fixtures


def build_gov_extra3(rng: random.Random) -> list[Fixture]:
    """More government-portal pages beyond `gov-001..008` — corpus growth pass."""
    fixtures = []

    vehicle_state = rng.choice(["KA", "MH", "DL", "TN", "UP", "GJ"])
    vehicle_reg = f"{vehicle_state}{rng.randint(1,99):02d} {rng.choice('ABCDEFGHJKLMNPQRSTUVWXYZ')}{rng.choice('ABCDEFGHJKLMNPQRSTUVWXYZ')} {rng.randint(1000,9999)}"
    name = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=6))
    vehicle_box = (220, 120, 160, 22)
    name_box = (220, 160, 180, 22)
    fixtures.append(
        Fixture(
            "gov-009", "gov", "gov", "e-Challan Payment",
            '<div class="heading">e-Challan Payment</div>'
            + field_html("Vehicle registration", vehicle_reg, vehicle_box, "vehicle")
            + field_html("Owner name", name, name_box, "name"),
            [
                LabelItem("VEHICLE_REG", vehicle_box, sha256_hash(vehicle_reg)),
                LabelItem("PERSON_NAME", name_box, sha256_hash(name.lower())),
            ],
            notes="Traffic e-challan payment page: vehicle registration, owner name.",
        )
    )

    base = random_aadhaar_base(rng)
    aadhaar = base + verhoeff_generate(base)
    account = random_bank_account(rng)
    aadhaar_box = (220, 120, 160, 22)
    account_box = (220, 160, 180, 22)
    fixtures.append(
        Fixture(
            "gov-010", "gov", "gov", "Scholarship Application",
            '<div class="heading">Scholarship Application</div>'
            + field_html("Aadhaar number", aadhaar, aadhaar_box, "aadhaar")
            + field_html("Bank account for disbursal", account, account_box, "account"),
            [
                LabelItem("AADHAAR", aadhaar_box, sha256_hash(aadhaar)),
                LabelItem("BANK_ACCOUNT", account_box, sha256_hash(account), note="disclosed gap: no dedicated BANK_ACCOUNT pattern recognizer yet — expected FN"),
            ],
            notes="Scholarship application: Aadhaar with label context, bank account disclosed gap.",
        )
    )

    passport_letter = rng.choice("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
    passport_digits = "".join(str(rng.randint(0, 9)) for _ in range(7))
    passport = passport_letter + passport_digits
    passport_box = (220, 120, 120, 22)
    fixtures.append(
        Fixture(
            "gov-011", "gov", "gov", "Passport Renewal",
            '<div class="heading">Passport Renewal</div>'
            + field_html_input("Passport number", passport, passport_box, "passport"),
            [LabelItem("PASSPORT", passport_box, sha256_hash(passport))],
            notes="Passport renewal page: PASSPORT via a real <label for>-associated <input> (genuinely detectable, per gov-004's earlier correction).",
        )
    )

    return fixtures


def build_health_extra2(rng: random.Random) -> list[Fixture]:
    """More healthcare pages beyond `health-001..009` — corpus growth pass."""
    fixtures = []

    name = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=6))
    phone = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    name_box = (220, 120, 200, 22)
    phone_box = (220, 160, 160, 22)
    fixtures.append(
        Fixture(
            "health-010", "health", "health", "Prescription Refill Request",
            '<div class="heading">Prescription Refill Request</div>'
            + field_html("Patient name", name, name_box, "name")
            + field_html("Phone", phone, phone_box, "phone"),
            [
                LabelItem("PERSON_NAME", name_box, sha256_hash(name.lower())),
                LabelItem("PHONE", phone_box, sha256_hash(phone.replace(" ", "").replace("+", ""))),
            ],
            notes="Prescription refill request: name, phone.",
        )
    )

    name2 = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=6))
    base = random_aadhaar_base(rng)
    aadhaar = base + verhoeff_generate(base)
    name2_box = (220, 120, 200, 22)
    aadhaar_box = (220, 160, 160, 22)
    fixtures.append(
        Fixture(
            "health-011", "health", "health", "Blood Donation Registration",
            '<div class="heading">Blood Donation Registration</div>'
            + field_html("Donor name", name2, name2_box, "name")
            + field_html("Aadhaar number", aadhaar, aadhaar_box, "aadhaar"),
            [
                LabelItem("PERSON_NAME", name2_box, sha256_hash(name2.lower())),
                LabelItem("AADHAAR", aadhaar_box, sha256_hash(aadhaar)),
            ],
            notes="Blood donation camp registration: donor name, Aadhaar with label context.",
        )
    )

    return fixtures


def build_forms_extra2(rng: random.Random) -> list[Fixture]:
    """More form pages beyond `forms-001..008` — corpus growth pass."""
    fixtures = []

    email = "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=8)) + "@example.test"
    phone = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    email_box = (220, 120, 220, 28)
    phone_box = (220, 160, 180, 28)
    fixtures.append(
        Fixture(
            "forms-009", "social", "forms", "Profile Settings",
            '<div class="heading">Profile Settings</div>'
            + field_html("Email", email, email_box, "email")
            + field_html("Phone", phone, phone_box, "phone"),
            [
                LabelItem("EMAIL", email_box, sha256_hash(email.lower())),
                LabelItem("PHONE", phone_box, sha256_hash(phone.replace(" ", "").replace("+", ""))),
            ],
            notes="Profile settings form: email, phone.",
        )
    )

    password_len = rng.randint(8, 14)
    pass_box = (220, 120, 220, 28)
    fixtures.append(
        Fixture(
            "forms-010", "social", "forms", "Delete Account Confirmation",
            '<div class="heading">Delete Account Confirmation</div>'
            + f'<div class="field-label" style="left:220px;top:102px;">Confirm password</div>'
              f'<input id="password" type="password" value="{"x" * password_len}" '
              f'style="position:absolute;left:{pass_box[0]}px;top:{pass_box[1]}px;'
              f'width:{pass_box[2]}px;height:{pass_box[3]}px;">',
            [LabelItem("PASSWORD", pass_box, note=None)],
            notes="Delete-account confirmation form: password field (presence only, value never read).",
        )
    )

    return fixtures


def build_faces_extra3(_rng: random.Random) -> list[Fixture]:
    """More vision-channel-shaped pages beyond `faces-001..009` — corpus growth pass."""
    box = (220, 120, 100, 100)
    return [
        Fixture(
            "faces-010", "gov", "faces", "Staff ID Badge",
            '<div class="heading">Staff ID Badge</div>'
            + f'<div id="photo-region" style="position:absolute;left:{box[0]}px;top:{box[1]}px;">'
              f'{_svg_placeholder("face", box[2], box[3])}</div>',
            [LabelItem("FACE", box)],
            notes="A staff ID badge's photo region, placeholder graphic.",
        )
    ]


def build_indic_extra3(rng: random.Random) -> list[Fixture]:
    """More Indic-script pages beyond `indic-001..009` — corpus growth pass."""
    fixtures = []

    base = random_aadhaar_base(rng)
    aadhaar = base + verhoeff_generate(base)
    grouped = f"{aadhaar[0:4]} {aadhaar[4:8]} {aadhaar[8:12]}"
    box = (220, 120, 160, 24)
    fixtures.append(
        Fixture(
            "indic-010", "gov", "indic", "ଆଧାର ପଞ୍ଜୀକରଣ ନିଶ୍ଚିତକରଣ",
            '<div class="heading">ଆଧାର ପଞ୍ଜୀକରଣ ନିଶ୍ଚିତକରଣ</div>'
            + field_html("ଆଧାର ସଂଖ୍ୟା", grouped, box, "aadhaar"),
            [LabelItem("AADHAAR", box, sha256_hash(aadhaar))],
            notes="Odia-script government portal; Aadhaar digits stay ASCII.",
            script="odia",
        )
    )

    pan_prefix3 = "".join(rng.choices("ABCDEFGHIJKLMNPQRSTUVWXYZ", k=3))
    pan_holder_type = rng.choice("ABCPFGHLTJ")
    pan_letter5 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan_digits = "".join(str(rng.randint(0, 9)) for _ in range(4))
    pan_letter2 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan = pan_prefix3 + pan_holder_type + pan_letter5 + pan_digits + pan_letter2
    box2 = (220, 120, 120, 22)
    fixtures.append(
        Fixture(
            "indic-011", "banking", "indic", "पॅन पडताळणी",
            '<div class="heading">पॅन पडताळणी</div>'
            + field_html("पॅन क्रमांक", pan, box2, "pan"),
            [LabelItem("PAN", box2, sha256_hash(pan))],
            notes="Marathi-script (Devanagari) banking form; fictitious PAN, structurally valid.",
            script="marathi",
        )
    )

    return fixtures


def build_coverage_extra(rng: random.Random) -> list[Fixture]:
    """Three entities had zero fixtures anywhere in the corpus despite each having a real,
    implemented Channel T recognizer (`packages/recognizers/src/patterns/{card,pin,secret}.ts`) —
    found by counting label items per entity across `generate_all()`'s own output, the same way
    the BANK_ACCOUNT gap (no recognizer at all — a *different*, already-disclosed gap) was found.
    Zero fixtures means zero measured data points: we would not actually know if CARD_EXPIRY,
    PIN_CODE or SECRET detection works at all. This pass closes that.  Also bumps VEHICLE_REG and
    UPI_VPA (2 each — too few for recall to mean anything) to 3."""
    fixtures = []

    # forms-011: CARD_EXPIRY — channel-d.ts's own autocomplete="cc-exp" rule, score 1.0.
    expiry_box = (220, 120, 80, 28)
    expiry_value = f"{rng.randint(1, 12):02d}/{rng.randint(26, 31)}"
    fixtures.append(
        Fixture(
            "forms-011", "banking", "forms", "Update Card",
            '<div class="heading">Update Card</div>'
            + f'<div class="field-label" style="left:220px;top:102px;">Expiry</div>'
              f'<input id="cc-exp" autocomplete="cc-exp" type="text" value="{expiry_value}" '
              f'style="position:absolute;left:{expiry_box[0]}px;top:{expiry_box[1]}px;'
              f'width:{expiry_box[2]}px;height:{expiry_box[3]}px;">',
            [LabelItem("CARD_EXPIRY", expiry_box, sha256_hash(expiry_value))],
            notes="Card expiry field via autocomplete=cc-exp (valueRead=true per channel-d.ts, unlike CARD_NUMBER/CVV) — first CARD_EXPIRY fixture in the corpus.",
        )
    )

    # gov-012: PIN_CODE — pin.ts requires ADDRESS_LEXICON context ('pin code'/'postal code'/etc.)
    # to score above its no-context floor; field_html_input gives it a real <label for> context.
    pin_value = str(rng.randint(1, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(5))
    addr_box = (220, 120, 260, 22)
    pin_box = (220, 160, 100, 22)
    address_line = "".join(rng.choices("0123456789", k=2)) + " MG Road"
    fixtures.append(
        Fixture(
            "gov-012", "gov", "gov", "Update Address",
            '<div class="heading">Update Address</div>'
            + field_html_input("Street address", address_line, addr_box, "address")
            + field_html_input("PIN code", pin_value, pin_box, "pincode"),
            [
                LabelItem("ADDRESS", addr_box, sha256_hash(address_line.lower())),
                LabelItem("PIN_CODE", pin_box, sha256_hash(pin_value)),
            ],
            notes="Address-update form with a real <label for> on the PIN field — first PIN_CODE fixture in the corpus (context-required per design.md §6.2).",
        )
    )

    # freetext-008/009: SECRET — secret.ts is a real, context-free Channel T pattern (known-prefix
    # API keys, JWT shape, PEM headers, generic high-entropy fallback), never exercised before.
    api_key = "sk-" + "".join(rng.choices("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", k=32))
    box3 = (220, 120, 380, 22)
    fixtures.append(
        Fixture(
            "freetext-008", "docs", "freetext", "Internal Wiki — API Access",
            '<div class="heading">Internal Wiki — API Access</div>'
            + field_html("API key", api_key, box3, "apikey"),
            [LabelItem("SECRET", box3, sha256_hash(api_key))],
            notes="A known-prefix API key (sk-...) in free text — secret.ts's KNOWN_PREFIX_RE, score 0.9, first SECRET fixture in the corpus.",
        )
    )

    jwt_header = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
    jwt_payload = "".join(rng.choices("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", k=24))
    jwt_sig = "".join(rng.choices("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-", k=32))
    jwt = f"{jwt_header}.{jwt_payload}.{jwt_sig}"
    box4 = (220, 120, 900, 22)
    fixtures.append(
        Fixture(
            "freetext-009", "docs", "freetext", "Internal Wiki — Session Debug",
            '<div class="heading">Internal Wiki — Session Debug</div>'
            + field_html("Session token", jwt, box4, "jwt"),
            [LabelItem("SECRET", box4, sha256_hash(jwt))],
            notes="A JWT-shaped token in free text — secret.ts's JWT_RE, score 0.9.",
        )
    )

    # hardneg-018: a long *unbroken* digit-only run is a safe SECRET hard negative on two counts —
    # secret.ts's entropy threshold (3.5 bits/char) is mathematically unreachable for a digits-only
    # alphabet (max possible entropy log2(10) ≈ 3.32 bits/char), and (per the CARD_NUMBER/AADHAAR
    # collision fix earlier this pass series) an unbroken digit run has no internal `\b` word
    # boundary for `aadhaar.ts`/`card.ts`/`phone.ts` to anchor a sub-match to — only its own start
    # and end are boundaries, and at length 24 that whole span is outside every one of those
    # recognizers' own valid length ranges (12, 13-19, 10). Safe by construction, not by luck.
    tracking_number = "".join(str(rng.randint(0, 9)) for _ in range(24))
    box5 = (220, 120, 260, 22)
    fixtures.append(
        Fixture(
            "hardneg-018", "docs", "hardneg", "Order Tracking",
            '<div class="heading">Order Tracking</div>'
            + field_html("Tracking number", tracking_number, box5, "tracking"),
            [LabelItem("NONE", box5, note="24-digit tracking number: below secret.ts's entropy floor (digits-only max entropy ~3.32 < 3.5) and outside every digit-pattern recognizer's valid length range — must pass through.")],
            notes="Long digit-only tracking number — hard negative for SECRET's generic high-entropy fallback and every digit-shaped recognizer at once.",
        )
    )

    # id-016: VEHICLE_REG — bumping n=2 to n=3 (too few to trust a recall figure at n=2).
    state = rng.choice(["KA", "MH", "DL", "TN", "GJ"])
    district = f"{rng.randint(1, 99):02d}"
    series = "".join(rng.choices("ABCDEFGHJKLMNPQRSTUVWXYZ", k=2))
    plate_digits = f"{rng.randint(1, 9999):04d}"
    plate = f"{state} {district} {series} {plate_digits}"
    box6 = (220, 120, 160, 22)
    fixtures.append(
        Fixture(
            "id-016", "gov", "identifiers", "Vehicle Insurance Renewal",
            '<div class="heading">Vehicle Insurance Renewal</div>'
            + field_html("Registration number", plate, box6, "vehicle"),
            [LabelItem("VEHICLE_REG", box6, sha256_hash(plate.replace(" ", "")))],
            notes="Fictitious vehicle registration, real state RTO code.",
        )
    )

    # id-017: UPI_VPA — bumping n=2 to n=3, using a known PSP handle (upi.ts's KNOWN_HANDLES).
    handle_name = "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=7))
    vpa = f"{handle_name}@oksbi"
    box7 = (220, 120, 220, 22)
    fixtures.append(
        Fixture(
            "id-017", "banking", "identifiers", "Split Bill Request",
            '<div class="heading">Split Bill Request</div>'
            + field_html("Pay to UPI ID", vpa, box7, "vpa"),
            [LabelItem("UPI_VPA", box7, sha256_hash(vpa.lower()))],
            notes="UPI VPA with a known PSP handle (oksbi) — upi.ts's KNOWN_HANDLES, score 0.9.",
        )
    )

    return fixtures


def build_identifiers_extra4(rng: random.Random) -> list[Fixture]:
    """More identifier-shaped pages beyond `id-001..017` — corpus growth pass 5 (T-5.1 push toward
    200). Real content-authoring: distinct pages/purposes, not a parameterized loop."""
    fixtures = []

    base = random_aadhaar_base(rng)
    aadhaar = base + verhoeff_generate(base)
    box = (220, 120, 160, 22)
    fixtures.append(
        Fixture(
            "id-018", "gov", "identifiers", "e-KYC Confirmation",
            '<div class="heading">e-KYC Confirmation</div>'
            + field_html("Aadhaar number", aadhaar, box, "aadhaar"),
            [LabelItem("AADHAAR", box, sha256_hash(aadhaar))],
            notes="Fictitious Aadhaar, valid Verhoeff checksum.",
        )
    )

    pan_prefix3 = "".join(rng.choices("ABCDEFGHIJKLMNPQRSTUVWXYZ", k=3))
    pan_holder_type = rng.choice("ABCPFGHLTJ")
    pan_letter5 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan_digits = "".join(str(rng.randint(0, 9)) for _ in range(4))
    pan_letter2 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan = pan_prefix3 + pan_holder_type + pan_letter5 + pan_digits + pan_letter2
    box2 = (220, 120, 130, 22)
    fixtures.append(
        Fixture(
            "id-019", "gov", "identifiers", "Income Tax e-Filing",
            '<div class="heading">Income Tax e-Filing</div>'
            + field_html("PAN", pan, box2, "pan"),
            [LabelItem("PAN", box2, sha256_hash(pan))],
            notes="Fictitious PAN, structurally valid.",
        )
    )

    state = f"{rng.randint(1, 37):02d}"
    pan_prefix3b = "".join(rng.choices("ABCDEFGHIJKLMNPQRSTUVWXYZ", k=3))
    pan_holder_typeb = rng.choice("ABCPFGHLTJ")
    pan_letter5b = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan_digitsb = "".join(str(rng.randint(0, 9)) for _ in range(4))
    pan_letter2b = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    panb = pan_prefix3b + pan_holder_typeb + pan_letter5b + pan_digitsb + pan_letter2b
    prefix14 = state + panb + "1" + "Z"
    check = gstin_generate(prefix14)
    gstin = prefix14 + check
    box3 = (220, 120, 150, 22)
    fixtures.append(
        Fixture(
            "id-020", "gov", "identifiers", "GST Return Filing",
            '<div class="heading">GST Return Filing</div>'
            + field_html("GSTIN", gstin, box3, "gstin"),
            [LabelItem("GSTIN", box3, sha256_hash(gstin))],
            notes="Fictitious GSTIN, valid check character.",
        )
    )

    bank_code = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=4))
    ifsc = bank_code + "0" + "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", k=6))
    box4 = (220, 120, 130, 22)
    fixtures.append(
        Fixture(
            "id-021", "banking", "identifiers", "NEFT Transfer",
            '<div class="heading">NEFT Transfer</div>'
            + field_html("Beneficiary IFSC", ifsc, box4, "ifsc"),
            [LabelItem("IFSC", box4, sha256_hash(ifsc))],
            notes="Fictitious IFSC, structurally valid (4 letters, literal 0, 6 alnum).",
        )
    )

    bank_code2 = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=4))
    ifsc2 = bank_code2 + "0" + "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", k=6))
    box5 = (220, 120, 130, 22)
    fixtures.append(
        Fixture(
            "id-022", "banking", "identifiers", "RTGS Transfer",
            '<div class="heading">RTGS Transfer</div>'
            + field_html("Beneficiary IFSC", ifsc2, box5, "ifsc"),
            [LabelItem("IFSC", box5, sha256_hash(ifsc2))],
            notes="Fictitious IFSC, structurally valid — second RTGS/NEFT-style instance.",
        )
    )

    state2 = rng.choice(["MH", "TN", "DL", "GJ", "UP"])
    district2 = f"{rng.randint(1, 99):02d}"
    series2 = "".join(rng.choices("ABCDEFGHJKLMNPQRSTUVWXYZ", k=2))
    plate_digits2 = f"{rng.randint(1, 9999):04d}"
    plate2 = f"{state2} {district2} {series2} {plate_digits2}"
    box6 = (220, 120, 160, 22)
    fixtures.append(
        Fixture(
            "id-023", "gov", "identifiers", "Vehicle Registration Renewal",
            '<div class="heading">Vehicle Registration Renewal</div>'
            + field_html("Registration number", plate2, box6, "vehicle"),
            [LabelItem("VEHICLE_REG", box6, sha256_hash(plate2.replace(" ", "")))],
            notes="Fictitious vehicle registration, real state RTO code — bumping VEHICLE_REG's n further.",
        )
    )

    handle2 = "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=6))
    vpa2 = f"{handle2}@paytm"
    box7 = (220, 120, 200, 22)
    fixtures.append(
        Fixture(
            "id-024", "banking", "identifiers", "Recharge Payment",
            '<div class="heading">Recharge Payment</div>'
            + field_html("UPI ID", vpa2, box7, "vpa"),
            [LabelItem("UPI_VPA", box7, sha256_hash(vpa2.lower()))],
            notes="UPI VPA with a known PSP handle (paytm) — bumping UPI_VPA's n further.",
        )
    )

    visa_base = "4" + "".join(str(rng.randint(0, 9)) for _ in range(14))
    visa_card = visa_base + luhn_generate(visa_base)
    visa_grouped = " ".join(visa_card[i : i + 4] for i in range(0, 16, 4))
    box8 = (220, 120, 190, 22)
    fixtures.append(
        Fixture(
            "id-025", "banking", "identifiers", "Subscription Renewal",
            '<div class="heading">Subscription Renewal</div>'
            + field_html("Card number", visa_grouped, box8, "card"),
            [LabelItem("CARD_NUMBER", box8, sha256_hash(visa_card))],
            notes="Fictitious card number, valid Luhn checksum, Visa-range IIN.",
        )
    )

    cvv2 = "".join(str(rng.randint(0, 9)) for _ in range(3))
    box9 = (220, 120, 60, 22)
    fixtures.append(
        Fixture(
            "id-026", "banking", "identifiers", "Online Checkout",
            '<div class="heading">Online Checkout</div>'
            + f'<div class="field-label" style="left:220px;top:102px;">CVV</div>'
              f'<input id="cc-csc" autocomplete="cc-csc" type="text" value="{cvv2}" '
              f'style="position:absolute;left:{box9[0]}px;top:{box9[1]}px;'
              f'width:{box9[2]}px;height:{box9[3]}px;">',
            [LabelItem("CARD_CVV", box9)],
            notes="CVV field — presence only, bumping CARD_CVV's n beyond 1.",
        )
    )

    return fixtures


def build_hardneg_extra4(rng: random.Random) -> list[Fixture]:
    """More hard negatives beyond `hardneg-001..018` — corpus growth pass 5. Each targets a
    different recognizer's own documented invalid/edge path, checked against source first."""
    fixtures = []

    pan_prefix3 = "".join(rng.choices("ABCDEFGHIJKLMNPQRSTUVWXYZ", k=3))
    bad_holder = rng.choice("DEIKMNOQRSUVWXYZ")  # NOT in pan.ts's HOLDER_TYPES set
    pan_letter5 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan_digits = "".join(str(rng.randint(0, 9)) for _ in range(4))
    pan_letter2 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    fake_pan = pan_prefix3 + bad_holder + pan_letter5 + pan_digits + pan_letter2
    box = (220, 120, 130, 22)
    fixtures.append(
        Fixture(
            "hardneg-019", "docs", "hardneg", "Product Catalogue",
            '<div class="heading">Product Catalogue</div>'
            + field_html("SKU", fake_pan, box, "sku"),
            [LabelItem("NONE", box, note="PAN-shaped SKU (5 letters, 4 digits, 1 letter) whose 4th letter is NOT a real holder-type code — pan.ts's HOLDER_TYPES check correctly rejects it.")],
            notes="PAN-shaped catalogue SKU with an invalid holder-type letter — must pass through.",
        )
    )

    bank_code = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=4))
    fake_ifsc = bank_code + "1" + "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", k=6))
    box2 = (220, 120, 130, 22)
    fixtures.append(
        Fixture(
            "hardneg-020", "docs", "hardneg", "Warehouse Bin Label",
            '<div class="heading">Warehouse Bin Label</div>'
            + field_html("Bin code", fake_ifsc, box2, "bin"),
            [LabelItem("NONE", box2, note="IFSC-shaped bin code with '1' (not the required literal '0') at position 5 — ifsc.ts's IFSC_RE cannot match it at all.")],
            notes="IFSC-shaped 11-char code failing the literal-0-at-position-5 structural requirement — must pass through.",
        )
    )

    district3 = f"{rng.randint(1, 99):02d}"
    series3 = "".join(rng.choices("ABCDEFGHJKLMNPQRSTUVWXYZ", k=2))
    plate_digits3 = f"{rng.randint(1, 9999):04d}"
    fake_plate = f"ZZ {district3} {series3} {plate_digits3}"
    box3 = (220, 120, 160, 22)
    fixtures.append(
        Fixture(
            "hardneg-021", "docs", "hardneg", "Parking Permit Sample",
            '<div class="heading">Parking Permit Sample</div>'
            + field_html("Sample plate", fake_plate, box3, "plate"),
            [LabelItem("NONE", box3, note="Vehicle-plate-shaped sample with state code 'ZZ', not a real Indian RTO code — vehicle.ts's STATE_CODES check correctly rejects it.")],
            notes="Vehicle-registration-shaped sample plate with a non-real state code — must pass through.",
        )
    )

    mc_base = rng.choice(["51", "52", "53", "54", "55"]) + "".join(str(rng.randint(0, 9)) for _ in range(13))
    mc_check = luhn_generate(mc_base)
    bad_check = str((int(mc_check) + 1) % 10)
    fake_card = mc_base + bad_check
    box4 = (220, 120, 190, 22)
    fixtures.append(
        Fixture(
            "hardneg-022", "docs", "hardneg", "Membership Card Sample",
            '<div class="heading">Membership Card Sample</div>'
            + field_html("Sample number", fake_card, box4, "cardsample"),
            [LabelItem("NONE", box4, note="16-digit Mastercard-range-IIN sample number with a deliberately wrong Luhn check digit — card.ts scores invalid at 0.1, below the redaction floor.")],
            notes="Luhn-invalid, Mastercard-IIN-shaped sample number — must pass through.",
        )
    )

    aad_base = random_aadhaar_base(rng)
    real_check = verhoeff_generate(aad_base)
    wrong_check = str((int(real_check) + 1) % 10)
    fake_aadhaar = aad_base + wrong_check
    box5 = (220, 120, 160, 22)
    fixtures.append(
        Fixture(
            "hardneg-023", "docs", "hardneg", "Training Material Sample",
            '<div class="heading">Training Material Sample</div>'
            + field_html("Example ID (do not use)", fake_aadhaar, box5, "example"),
            [LabelItem("NONE", box5, note="12-digit Aadhaar-shaped example ID with a deliberately wrong Verhoeff check digit — aadhaar.ts scores invalid, no-context at 0.1, below the redaction floor.")],
            notes="Verhoeff-invalid Aadhaar-shaped training example — must pass through.",
        )
    )

    low_entropy = "AB" * 14  # 28 chars, 2-symbol alternation — Shannon entropy 1 bit/char, well
    # below secret.ts's 3.5 threshold regardless of alphabet (unlike hardneg-018's digits-only
    # argument, this one is about repetition, not alphabet size).
    box6 = (220, 120, 260, 22)
    fixtures.append(
        Fixture(
            "hardneg-024", "docs", "hardneg", "Batch Reference Lookup",
            '<div class="heading">Batch Reference Lookup</div>'
            + field_html("Batch reference", low_entropy, box6, "batchref"),
            [LabelItem("NONE", box6, note="28-char 2-symbol alternating reference code — Shannon entropy 1 bit/char, below secret.ts's 3.5 threshold regardless of alphabet size.")],
            notes="A repetitive, low-entropy 'reference code' — a SECRET hard negative via a different mechanism than hardneg-018's digit-only one.",
        )
    )

    passport_letter = rng.choice("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
    passport_digits = "".join(str(rng.randint(0, 9)) for _ in range(7))
    fake_passport = passport_letter + passport_digits
    box7 = (220, 120, 120, 22)
    fixtures.append(
        Fixture(
            "hardneg-025", "docs", "hardneg", "Warranty Registration",
            '<div class="heading">Warranty Registration</div>'
            + field_html("Serial number", fake_passport, box7, "serial"),
            [LabelItem("NONE", box7, note="Passport-shaped ([A-Z]+7 digits) warranty serial number with no 'passport' context anywhere on the page — passport.ts's no-context score (0.3) is below HIGH's 0.35 floor.")],
            notes="Passport-shaped warranty serial number in a non-passport context — must pass through, design.md §6.2's context-required pattern.",
        )
    )

    order_number = str(rng.randint(1, 5)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    box8 = (220, 120, 150, 22)
    fixtures.append(
        Fixture(
            "hardneg-026", "docs", "hardneg", "Order Status Lookup",
            '<div class="heading">Order Status Lookup</div>'
            + field_html("Order number", order_number, box8, "orderno"),
            [LabelItem("NONE", box8, note="10-digit order number starting 1-5 — phone.ts's INDIAN_MOBILE_RE requires a 6-9 first digit, so this cannot match as PHONE.")],
            notes="A 10-digit order number deliberately outside PHONE's 6-9-first-digit range — must pass through.",
        )
    )

    return fixtures


def build_forms_extra3(rng: random.Random) -> list[Fixture]:
    """More form pages beyond `forms-001..011` — corpus growth pass 5."""
    fixtures = []

    pw_len = rng.randint(8, 16)
    box = (220, 160, 220, 28)
    box_old = (220, 120, 220, 28)
    fixtures.append(
        Fixture(
            "forms-012", "social", "forms", "Change Password",
            '<div class="heading">Change Password</div>'
            + f'<div class="field-label" style="left:220px;top:102px;">Current password</div>'
              f'<input id="old-pw" type="password" value="{"x" * rng.randint(8, 14)}" '
              f'style="position:absolute;left:{box_old[0]}px;top:{box_old[1]}px;'
              f'width:{box_old[2]}px;height:{box_old[3]}px;">'
            + f'<div class="field-label" style="left:220px;top:142px;">New password</div>'
              f'<input id="new-pw" type="password" value="{"x" * pw_len}" '
              f'style="position:absolute;left:{box[0]}px;top:{box[1]}px;'
              f'width:{box[2]}px;height:{box[3]}px;">',
            [LabelItem("PASSWORD", box_old), LabelItem("PASSWORD", box)],
            notes="Two password fields (current + new) — presence only, bumping PASSWORD's n.",
        )
    )

    name = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(
        rng.choices("abcdefghijklmnopqrstuvwxyz", k=6)
    )
    bank_account = random_bank_account(rng)
    bank_code = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=4))
    ifsc = bank_code + "0" + "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", k=6))
    name_box = (220, 120, 200, 24)
    acct_box = (220, 160, 180, 24)
    ifsc_box = (220, 200, 130, 24)
    fixtures.append(
        Fixture(
            "forms-013", "banking", "forms", "Add Bank Beneficiary",
            '<div class="heading">Add Bank Beneficiary</div>'
            + field_html("Beneficiary name", name, name_box, "name")
            + field_html("Account number", bank_account, acct_box, "acct")
            + field_html("IFSC", ifsc, ifsc_box, "ifsc"),
            [
                LabelItem("PERSON_NAME", name_box, sha256_hash(name.lower())),
                LabelItem("BANK_ACCOUNT", acct_box, sha256_hash(bank_account)),
                LabelItem("IFSC", ifsc_box, sha256_hash(ifsc)),
            ],
            notes="Bank beneficiary form: name, account number (BANK_ACCOUNT — disclosed no-recognizer gap), IFSC.",
        )
    )

    phone = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    phone_box = (220, 120, 200, 24)
    fixtures.append(
        Fixture(
            "forms-014", "social", "forms", "Update Mobile Number",
            '<div class="heading">Update Mobile Number</div>'
            + field_html("New mobile number", phone, phone_box, "phone"),
            [LabelItem("PHONE", phone_box, sha256_hash(phone.replace(" ", "").replace("+", "")))],
            notes="Mobile-number-update form, single PHONE field.",
        )
    )

    otp_box = (220, 120, 120, 28)
    fixtures.append(
        Fixture(
            "forms-015", "banking", "forms", "Withdraw Confirmation",
            '<div class="heading">Withdraw Confirmation</div>'
            + f'<div class="field-label" style="left:220px;top:102px;">One-time code</div>'
              f'<input id="otp" autocomplete="one-time-code" type="text" value="{"".join(str(rng.randint(0,9)) for _ in range(6))}" '
              f'style="position:absolute;left:{otp_box[0]}px;top:{otp_box[1]}px;'
              f'width:{otp_box[2]}px;height:{otp_box[3]}px;">',
            [LabelItem("OTP", otp_box)],
            notes="ATM/withdrawal OTP field — presence only, bumping OTP's n.",
        )
    )

    username = "".join(rng.choices("abcdefghijklmnopqrstuvwxyz0123456789_", k=10))
    email = "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=8)) + "@example.test"
    user_box = (220, 120, 200, 24)
    email_box = (220, 160, 220, 24)
    fixtures.append(
        Fixture(
            "forms-016", "social", "forms", "Create Account",
            '<div class="heading">Create Account</div>'
            + field_html("Username", username, user_box, "username")
            + field_html("Email", email, email_box, "email"),
            [
                LabelItem("USERNAME", user_box, sha256_hash(username)),
                LabelItem("EMAIL", email_box, sha256_hash(email.lower())),
            ],
            notes="Sign-up form: username and email — bumping USERNAME's n.",
        )
    )

    return fixtures


def build_faces_extra4(_rng: random.Random) -> list[Fixture]:
    """More vision-channel-shaped pages beyond `faces-001..010` — corpus growth pass 5."""
    fixtures = []
    photo_box = (220, 120, 100, 100)
    fixtures.append(
        Fixture(
            "faces-011", "gov", "faces", "Passport Photo Upload",
            '<div class="heading">Passport Photo Upload</div>'
            + f'<div id="photo-region" style="position:absolute;left:{photo_box[0]}px;top:{photo_box[1]}px;">'
              f'{_svg_placeholder("face", photo_box[2], photo_box[3])}</div>',
            [LabelItem("FACE", photo_box)],
            notes="Passport photo upload widget, placeholder graphic.",
        )
    )
    doc_box = (220, 120, 160, 100)
    fixtures.append(
        Fixture(
            "faces-012", "gov", "faces", "Driving Licence Scan",
            '<div class="heading">Driving Licence Scan</div>'
            + f'<div id="doc-region" style="position:absolute;left:{doc_box[0]}px;top:{doc_box[1]}px;">'
              f'{_svg_placeholder("id_document", doc_box[2], doc_box[3])}</div>',
            [LabelItem("ID_DOCUMENT", doc_box)],
            notes="Driving licence scan region, placeholder graphic.",
        )
    )
    sig_box = (220, 120, 140, 60)
    fixtures.append(
        Fixture(
            "faces-013", "gov", "faces", "e-Sign Consent",
            '<div class="heading">e-Sign Consent</div>'
            + f'<div id="sig-region" style="position:absolute;left:{sig_box[0]}px;top:{sig_box[1]}px;">'
              f'{_svg_placeholder("signature", sig_box[2], sig_box[3])}</div>',
            [LabelItem("SIGNATURE", sig_box)],
            notes="e-Signature consent pad, placeholder graphic.",
        )
    )
    qr_box = (220, 120, 100, 100)
    fixtures.append(
        Fixture(
            "faces-014", "gov", "faces", "Event Check-in",
            '<div class="heading">Event Check-in</div>'
            + f'<div id="qr-region" style="position:absolute;left:{qr_box[0]}px;top:{qr_box[1]}px;">'
              f'{_svg_placeholder("qr_code", qr_box[2], qr_box[3])}</div>',
            [LabelItem("QR_CODE", qr_box)],
            notes="Event check-in QR code, placeholder graphic — bumping QR_CODE's n.",
        )
    )
    selfie_box = (220, 120, 100, 100)
    fixtures.append(
        Fixture(
            "faces-015", "banking", "faces", "Video KYC Selfie",
            '<div class="heading">Video KYC Selfie</div>'
            + f'<div id="selfie-region" style="position:absolute;left:{selfie_box[0]}px;top:{selfie_box[1]}px;">'
              f'{_svg_placeholder("face", selfie_box[2], selfie_box[3])}</div>',
            [LabelItem("FACE", selfie_box)],
            notes="Video KYC selfie-capture widget, placeholder graphic.",
        )
    )
    return fixtures


def build_freetext_extra2(rng: random.Random) -> list[Fixture]:
    """More free-flowing-prose pages beyond `freetext-001..009` — corpus growth pass 5. Widths
    are deliberately generous (auto-width divs, no explicit CSS width — the free-flowing pattern
    that needed correcting in every earlier pass) to avoid yet another box-check width miss."""
    fixtures = []

    name = "Suresh " + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=6)).capitalize()
    email = "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=8)) + "@example.test"
    box_name = (16, 60, 260, 22)
    box_email = (16, 90, 300, 22)
    fixtures.append(
        Fixture(
            "freetext-010", "social", "freetext", "Forum Post",
            f'<div id="fn" style="position:absolute;left:{box_name[0]}px;top:{box_name[1]}px;">'
            f"Posted by {name}</div>"
            f'<div id="em" style="position:absolute;left:{box_email[0]}px;top:{box_email[1]}px;">'
            f"Contact me: {email}</div>",
            [
                LabelItem("PERSON_NAME", box_name, sha256_hash(name.lower())),
                LabelItem("EMAIL", box_email, sha256_hash(email.lower())),
            ],
            notes="Forum post with a name and email in free-flowing text.",
        )
    )

    phone = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    addr = f"{rng.randint(1,999)} Link Road, Sector {rng.randint(1,50)}, Pune"
    box_phone = (16, 60, 340, 22)
    box_addr = (16, 90, 400, 22)
    fixtures.append(
        Fixture(
            "freetext-011", "social", "freetext", "Classified Ad",
            f'<div id="ph" style="position:absolute;left:{box_phone[0]}px;top:{box_phone[1]}px;">'
            f"Call {phone} for details</div>"
            f'<div id="ad" style="position:absolute;left:{box_addr[0]}px;top:{box_addr[1]}px;">'
            f"Pickup at {addr}.</div>",
            [
                LabelItem("PHONE", box_phone, sha256_hash(phone.replace(" ", "").replace("+", ""))),
                LabelItem("ADDRESS", box_addr, sha256_hash(addr.lower())),
            ],
            notes="Classified-ad-style page with a phone number and address in prose.",
        )
    )

    name3 = "Anita " + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=6)).capitalize()
    phone3 = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    box_name3 = (16, 60, 260, 22)
    box_phone3 = (16, 90, 340, 22)
    fixtures.append(
        Fixture(
            "freetext-012", "docs", "freetext", "Resume Snippet",
            f'<div id="fn3" style="position:absolute;left:{box_name3[0]}px;top:{box_name3[1]}px;">'
            f"{name3}, Senior Analyst</div>"
            f'<div id="ph3" style="position:absolute;left:{box_phone3[0]}px;top:{box_phone3[1]}px;">'
            f"Mobile: {phone3}</div>",
            [
                LabelItem("PERSON_NAME", box_name3, sha256_hash(name3.lower())),
                LabelItem("PHONE", box_phone3, sha256_hash(phone3.replace(" ", "").replace("+", ""))),
            ],
            notes="Resume-style snippet with a name and phone number in prose.",
        )
    )

    name4 = "Vikram " + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=6)).capitalize()
    handle4 = "@" + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz0123456789_", k=9))
    box_name4 = (16, 60, 260, 22)
    box_handle4 = (16, 90, 260, 22)
    fixtures.append(
        Fixture(
            "freetext-013", "social", "freetext", "Review Comment",
            f'<div id="fn4" style="position:absolute;left:{box_name4[0]}px;top:{box_name4[1]}px;">'
            f"{name4} wrote:</div>"
            f'<div id="un4" style="position:absolute;left:{box_handle4[0]}px;top:{box_handle4[1]}px;">'
            f"Reply to {handle4}</div>",
            [
                LabelItem("PERSON_NAME", box_name4, sha256_hash(name4.lower())),
                LabelItem("USERNAME", box_handle4, sha256_hash(handle4.lower())),
            ],
            notes="Review-comment-style page with a name and an @handle in prose.",
        )
    )

    return fixtures


def build_canvas_extra4(rng: random.Random) -> list[Fixture]:
    """More canvas-rendered pages beyond `canvas-001..006` — corpus growth pass 5."""
    fixtures = []

    pan_prefix3 = "".join(rng.choices("ABCDEFGHIJKLMNPQRSTUVWXYZ", k=3))
    pan_holder_type = rng.choice("ABCPFGHLTJ")
    pan_letter5 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan_digits = "".join(str(rng.randint(0, 9)) for _ in range(4))
    pan_letter2 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan = pan_prefix3 + pan_holder_type + pan_letter5 + pan_digits + pan_letter2
    box = (40, 154, 140, 22)
    fixtures.append(
        Fixture(
            "canvas-007", "canvas_app", "canvas", "Whiteboard App",
            '<div class="heading">Whiteboard App</div>'
            f'<canvas id="cv7" width="400" height="200" '
            f'style="position:absolute;left:20px;top:80px;border:1px solid #ccc;"></canvas>'
            + f"""
<script>
  const c7 = document.getElementById('cv7');
  const ctx7 = c7.getContext('2d');
  ctx7.font = '16px sans-serif';
  ctx7.fillStyle = '#111';
  ctx7.fillText('PAN on file:', 20, 60);
  ctx7.font = 'bold 16px sans-serif';
  ctx7.fillText('{pan}', 20, 90);
</script>
""",
            [LabelItem("PAN", box, sha256_hash(pan))],
            notes="Canvas-rendered PAN in a whiteboard-style app — DOM has no accessible text.",
        )
    )

    phone = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    box2 = (40, 154, 220, 22)
    fixtures.append(
        Fixture(
            "canvas-008", "canvas_app", "canvas", "Poster Maker",
            '<div class="heading">Poster Maker</div>'
            f'<canvas id="cv8" width="400" height="200" '
            f'style="position:absolute;left:20px;top:80px;border:1px solid #ccc;"></canvas>'
            + f"""
<script>
  const c8 = document.getElementById('cv8');
  const ctx8 = c8.getContext('2d');
  ctx8.font = '16px sans-serif';
  ctx8.fillStyle = '#111';
  ctx8.fillText('Contact for bookings:', 20, 60);
  ctx8.font = 'bold 16px sans-serif';
  ctx8.fillText('{phone}', 20, 90);
</script>
""",
            [LabelItem("PHONE", box2, sha256_hash(phone.replace(" ", "").replace("+", "")))],
            notes="Canvas-rendered phone number in a poster-maker-style app — DOM has no accessible text.",
        )
    )

    email = "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=8)) + "@example.test"
    box3 = (40, 154, 260, 22)
    fixtures.append(
        Fixture(
            "canvas-009", "canvas_app", "canvas", "Meme Generator",
            '<div class="heading">Meme Generator</div>'
            f'<canvas id="cv9" width="400" height="200" '
            f'style="position:absolute;left:20px;top:80px;border:1px solid #ccc;"></canvas>'
            + f"""
<script>
  const c9 = document.getElementById('cv9');
  const ctx9 = c9.getContext('2d');
  ctx9.font = '16px sans-serif';
  ctx9.fillStyle = '#111';
  ctx9.fillText('Submit yours to:', 20, 60);
  ctx9.font = 'bold 16px sans-serif';
  ctx9.fillText('{email}', 20, 90);
</script>
""",
            [LabelItem("EMAIL", box3, sha256_hash(email.lower()))],
            notes="Canvas-rendered email in a meme-generator-style app — DOM has no accessible text.",
        )
    )

    return fixtures


def build_pdf_extra4(rng: random.Random) -> list[Fixture]:
    """More PDF-viewer-shaped pages beyond `pdf-001..010` — corpus growth pass 5."""
    fixtures = []

    bank_account = random_bank_account(rng)
    bank_code = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=4))
    ifsc = bank_code + "0" + "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", k=6))
    acct_box = (60, 140, 180, 22)
    ifsc_box = (60, 170, 130, 22)
    fixtures.append(
        Fixture(
            "pdf-011", "docs", "pdf", "Bank Statement Viewer",
            '<div class="heading">Bank Statement Viewer</div>'
            + field_html("Account number", bank_account, acct_box, "acct")
            + field_html("IFSC", ifsc, ifsc_box, "ifsc"),
            [
                LabelItem("BANK_ACCOUNT", acct_box, sha256_hash(bank_account)),
                LabelItem("IFSC", ifsc_box, sha256_hash(ifsc)),
            ],
            notes="A PDF.js-viewer-shaped bank statement page.",
        )
    )

    base = random_aadhaar_base(rng)
    aadhaar = base + verhoeff_generate(base)
    aad_box = (60, 140, 160, 22)
    fixtures.append(
        Fixture(
            "pdf-012", "docs", "pdf", "Aadhaar Card Viewer",
            '<div class="heading">Aadhaar Card Viewer</div>'
            + field_html("Aadhaar number", aadhaar, aad_box, "aadhaar"),
            [LabelItem("AADHAAR", aad_box, sha256_hash(aadhaar))],
            notes="A PDF.js-viewer-shaped Aadhaar e-copy page.",
        )
    )

    pan_prefix3 = "".join(rng.choices("ABCDEFGHIJKLMNPQRSTUVWXYZ", k=3))
    pan_holder_type = rng.choice("ABCPFGHLTJ")
    pan_letter5 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan_digits = "".join(str(rng.randint(0, 9)) for _ in range(4))
    pan_letter2 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan = pan_prefix3 + pan_holder_type + pan_letter5 + pan_digits + pan_letter2
    name = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(
        rng.choices("abcdefghijklmnopqrstuvwxyz", k=6)
    )
    name_box = (60, 140, 200, 22)
    pan_box = (60, 170, 130, 22)
    fixtures.append(
        Fixture(
            "pdf-013", "docs", "pdf", "Salary Slip Viewer",
            '<div class="heading">Salary Slip Viewer</div>'
            + field_html("Employee name", name, name_box, "name")
            + field_html("PAN", pan, pan_box, "pan"),
            [
                LabelItem("PERSON_NAME", name_box, sha256_hash(name.lower())),
                LabelItem("PAN", pan_box, sha256_hash(pan)),
            ],
            notes="A PDF.js-viewer-shaped salary slip page.",
        )
    )

    name2 = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(
        rng.choices("abcdefghijklmnopqrstuvwxyz", k=7)
    )
    phone = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    name2_box = (60, 140, 200, 22)
    phone_box = (60, 170, 200, 22)
    fixtures.append(
        Fixture(
            "pdf-014", "docs", "pdf", "Insurance Policy Viewer",
            '<div class="heading">Insurance Policy Viewer</div>'
            + field_html("Policyholder", name2, name2_box, "name")
            + field_html("Contact number", phone, phone_box, "phone"),
            [
                LabelItem("PERSON_NAME", name2_box, sha256_hash(name2.lower())),
                LabelItem("PHONE", phone_box, sha256_hash(phone.replace(" ", "").replace("+", ""))),
            ],
            notes="A PDF.js-viewer-shaped insurance policy document page.",
        )
    )

    name3 = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(
        rng.choices("abcdefghijklmnopqrstuvwxyz", k=6)
    )
    email3 = "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=8)) + "@example.test"
    name3_box = (60, 140, 200, 22)
    email3_box = (60, 170, 220, 22)
    fixtures.append(
        Fixture(
            "pdf-015", "docs", "pdf", "Rental Agreement Viewer",
            '<div class="heading">Rental Agreement Viewer</div>'
            + field_html("Tenant name", name3, name3_box, "name")
            + field_html("Tenant email", email3, email3_box, "email"),
            [
                LabelItem("PERSON_NAME", name3_box, sha256_hash(name3.lower())),
                LabelItem("EMAIL", email3_box, sha256_hash(email3.lower())),
            ],
            notes="A PDF.js-viewer-shaped rental agreement document page.",
        )
    )

    return fixtures


def build_indic_extra4(rng: random.Random) -> list[Fixture]:
    """More Indic-script pages beyond `indic-001..011` — corpus growth pass 5. Adds Urdu
    (Perso-Arabic script, right-to-left) — genuinely new rendering territory (bidi text), not
    just another instance of an already-covered script."""
    fixtures = []

    base = random_aadhaar_base(rng)
    aadhaar = base + verhoeff_generate(base)
    grouped = f"{aadhaar[0:4]} {aadhaar[4:8]} {aadhaar[8:12]}"
    box = (220, 120, 160, 24)
    fixtures.append(
        Fixture(
            "indic-012", "gov", "indic", "आधार पंजीकरण की पुष्टि",
            '<div class="heading">आधार पंजीकरण की पुष्टि</div>'
            + field_html("आधार संख्या", grouped, box, "aadhaar"),
            [LabelItem("AADHAAR", box, sha256_hash(aadhaar))],
            notes="Hindi (Devanagari) government portal; Aadhaar digits stay ASCII.",
            script="devanagari",
        )
    )

    bank_code = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=4))
    ifsc = bank_code + "0" + "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", k=6))
    box2 = (220, 120, 150, 22)
    fixtures.append(
        Fixture(
            "indic-013", "banking", "indic", "வங்கிக் கிளை தேடல்",
            '<div class="heading">வங்கிக் கிளை தேடல்</div>'
            + field_html("IFSC குறியீடு", ifsc, box2, "ifsc"),
            [LabelItem("IFSC", box2, sha256_hash(ifsc))],
            notes="Tamil-script banking form; fictitious IFSC.",
            script="tamil",
        )
    )

    pan_prefix3 = "".join(rng.choices("ABCDEFGHIJKLMNPQRSTUVWXYZ", k=3))
    pan_holder_type = rng.choice("ABCPFGHLTJ")
    pan_letter5 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan_digits = "".join(str(rng.randint(0, 9)) for _ in range(4))
    pan_letter2 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan = pan_prefix3 + pan_holder_type + pan_letter5 + pan_digits + pan_letter2
    box3 = (220, 120, 130, 22)
    fixtures.append(
        Fixture(
            "indic-014", "banking", "indic", "প্যান যাচাইকরণ",
            '<div class="heading">প্যান যাচাইকরণ</div>'
            + field_html("প্যান নম্বর", pan, box3, "pan"),
            [LabelItem("PAN", box3, sha256_hash(pan))],
            notes="Bengali-script banking form; fictitious PAN.",
            script="bengali",
        )
    )

    phone = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    box4 = (220, 120, 200, 22)
    fixtures.append(
        Fixture(
            "indic-015", "social", "indic", "موبائل نمبر اپ ڈیٹ کریں",
            '<div class="heading" dir="rtl">موبائل نمبر اپ ڈیٹ کریں</div>'
            + f'<div class="field-label" dir="rtl" style="left:220px;top:102px;">نیا موبائل نمبر</div>'
              f'<div id="phone" class="field-value" dir="ltr" '
              f'style="left:{box4[0]}px;top:{box4[1]}px;width:{box4[2]}px;height:{box4[3]}px;">{phone}</div>',
            [LabelItem("PHONE", box4, sha256_hash(phone.replace(" ", "").replace("+", "")))],
            notes="Urdu-script (Perso-Arabic, right-to-left) mobile-number-update page — genuinely new bidi-text rendering territory, not just another already-covered script.",
            script="urdu",
        )
    )

    state = rng.choice(["KA", "TN", "AP", "TS"])
    district = f"{rng.randint(1, 99):02d}"
    series = "".join(rng.choices("ABCDEFGHJKLMNPQRSTUVWXYZ", k=2))
    plate_digits = f"{rng.randint(1, 9999):04d}"
    plate = f"{state} {district} {series} {plate_digits}"
    box5 = (220, 120, 160, 22)
    fixtures.append(
        Fixture(
            "indic-016", "gov", "indic", "ವಾಹನ ನೋಂದಣಿ",
            '<div class="heading">ವಾಹನ ನೋಂದಣಿ</div>'
            + field_html("ನೋಂದಣಿ ಸಂಖ್ಯೆ", plate, box5, "vehicle"),
            [LabelItem("VEHICLE_REG", box5, sha256_hash(plate.replace(" ", "")))],
            notes="Kannada-script vehicle-registration form; fictitious plate, real state RTO code.",
            script="kannada",
        )
    )

    return fixtures


def build_health_extra3(rng: random.Random) -> list[Fixture]:
    """More healthcare pages beyond `health-001..011` — corpus growth pass 5."""
    fixtures = []

    patient = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(
        rng.choices("abcdefghijklmnopqrstuvwxyz", k=6)
    )
    dob = f"{rng.randint(1,28):02d}-{rng.randint(1,12):02d}-19{rng.randint(60,99)}"
    name_box = (220, 120, 200, 22)
    dob_box = (220, 160, 120, 22)
    fixtures.append(
        Fixture(
            "health-012", "health", "health", "Lab Report Portal",
            '<div class="heading">Lab Report Portal</div>'
            + field_html("Patient name", patient, name_box, "name")
            + field_html("Date of birth", dob, dob_box, "dob"),
            [
                LabelItem("PERSON_NAME", name_box, sha256_hash(patient.lower())),
                LabelItem("DOB", dob_box, sha256_hash(dob)),
            ],
            notes="Lab report portal: name and DOB, no `<label for>` association (same disclosed no-context DOB gap as forms-004).",
        )
    )

    patient2 = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(
        rng.choices("abcdefghijklmnopqrstuvwxyz", k=7)
    )
    phone = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    name2_box = (220, 120, 200, 22)
    phone_box = (220, 160, 200, 22)
    fixtures.append(
        Fixture(
            "health-013", "health", "health", "Prescription Refill",
            '<div class="heading">Prescription Refill</div>'
            + field_html("Patient name", patient2, name2_box, "name")
            + field_html("Contact number", phone, phone_box, "phone"),
            [
                LabelItem("PERSON_NAME", name2_box, sha256_hash(patient2.lower())),
                LabelItem("PHONE", phone_box, sha256_hash(phone.replace(" ", "").replace("+", ""))),
            ],
            notes="Prescription-refill request form: name and contact number.",
        )
    )

    patient3 = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(
        rng.choices("abcdefghijklmnopqrstuvwxyz", k=6)
    )
    pan_prefix3 = "".join(rng.choices("ABCDEFGHIJKLMNPQRSTUVWXYZ", k=3))
    pan_holder_type = rng.choice("ABCPFGHLTJ")
    pan_letter5 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan_digits = "".join(str(rng.randint(0, 9)) for _ in range(4))
    pan_letter2 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan = pan_prefix3 + pan_holder_type + pan_letter5 + pan_digits + pan_letter2
    name3_box = (220, 120, 200, 22)
    pan_box = (220, 160, 130, 22)
    fixtures.append(
        Fixture(
            "health-014", "health", "health", "Insurance Claim Form",
            '<div class="heading">Insurance Claim Form</div>'
            + field_html("Claimant name", patient3, name3_box, "name")
            + field_html("PAN", pan, pan_box, "pan"),
            [
                LabelItem("PERSON_NAME", name3_box, sha256_hash(patient3.lower())),
                LabelItem("PAN", pan_box, sha256_hash(pan)),
            ],
            notes="Health-insurance claim form: claimant name and PAN.",
        )
    )

    patient4 = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(
        rng.choices("abcdefghijklmnopqrstuvwxyz", k=6)
    )
    email = "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=8)) + "@example.test"
    name4_box = (220, 120, 200, 22)
    email_box = (220, 160, 220, 22)
    fixtures.append(
        Fixture(
            "health-015", "health", "health", "Appointment Booking",
            '<div class="heading">Appointment Booking</div>'
            + field_html("Patient name", patient4, name4_box, "name")
            + field_html("Email", email, email_box, "email"),
            [
                LabelItem("PERSON_NAME", name4_box, sha256_hash(patient4.lower())),
                LabelItem("EMAIL", email_box, sha256_hash(email.lower())),
            ],
            notes="Doctor-appointment booking form: patient name and email.",
        )
    )

    patient5 = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(
        rng.choices("abcdefghijklmnopqrstuvwxyz", k=6)
    )
    base = random_aadhaar_base(rng)
    aadhaar = base + verhoeff_generate(base)
    name5_box = (220, 120, 200, 22)
    aad_box = (220, 160, 160, 22)
    fixtures.append(
        Fixture(
            "health-016", "health", "health", "Vaccination Certificate",
            '<div class="heading">Vaccination Certificate</div>'
            + field_html("Beneficiary name", patient5, name5_box, "name")
            + field_html("Aadhaar number", aadhaar, aad_box, "aadhaar"),
            [
                LabelItem("PERSON_NAME", name5_box, sha256_hash(patient5.lower())),
                LabelItem("AADHAAR", aad_box, sha256_hash(aadhaar)),
            ],
            notes="Vaccination certificate page: beneficiary name and Aadhaar.",
        )
    )

    return fixtures


def build_gov_extra4(rng: random.Random) -> list[Fixture]:
    """More government-portal pages beyond `gov-001..012` — corpus growth pass 5."""
    fixtures = []

    name = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(
        rng.choices("abcdefghijklmnopqrstuvwxyz", k=6)
    )
    base = random_aadhaar_base(rng)
    aadhaar = base + verhoeff_generate(base)
    name_box = (220, 120, 200, 22)
    aad_box = (220, 160, 160, 22)
    fixtures.append(
        Fixture(
            "gov-013", "gov", "gov", "Ration Card Application",
            '<div class="heading">Ration Card Application</div>'
            + field_html("Applicant name", name, name_box, "name")
            + field_html("Aadhaar number", aadhaar, aad_box, "aadhaar"),
            [
                LabelItem("PERSON_NAME", name_box, sha256_hash(name.lower())),
                LabelItem("AADHAAR", aad_box, sha256_hash(aadhaar)),
            ],
            notes="Ration card application: applicant name and Aadhaar.",
        )
    )

    name2 = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(
        rng.choices("abcdefghijklmnopqrstuvwxyz", k=7)
    )
    addr = f"{rng.randint(1,999)} Civil Lines, {rng.choice(['Nagpur','Indore','Bhopal','Patna'])}"
    name2_box = (220, 120, 200, 22)
    addr_box = (220, 160, 320, 22)
    fixtures.append(
        Fixture(
            "gov-014", "gov", "gov", "Voter ID Registration",
            '<div class="heading">Voter ID Registration</div>'
            + field_html("Applicant name", name2, name2_box, "name")
            + field_html("Residential address", addr, addr_box, "address"),
            [
                LabelItem("PERSON_NAME", name2_box, sha256_hash(name2.lower())),
                LabelItem("ADDRESS", addr_box, sha256_hash(addr.lower())),
            ],
            notes="Voter ID registration: applicant name and address (ADDRESS — disclosed Channel-L gap).",
        )
    )

    name3 = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(
        rng.choices("abcdefghijklmnopqrstuvwxyz", k=6)
    )
    dob = f"{rng.randint(1,28):02d}-{rng.randint(1,12):02d}-19{rng.randint(60,99)}"
    name3_box = (220, 120, 200, 22)
    dob_box = (220, 160, 120, 22)
    fixtures.append(
        Fixture(
            "gov-015", "gov", "gov", "Driving Licence Renewal",
            '<div class="heading">Driving Licence Renewal</div>'
            + field_html_input("Full name", name3, name3_box, "name")
            + field_html_input("Date of birth", dob, dob_box, "dob"),
            [
                LabelItem("PERSON_NAME", name3_box, sha256_hash(name3.lower())),
                LabelItem("DOB", dob_box, sha256_hash(dob)),
            ],
            notes="Driving licence renewal: name and DOB via real `<label for>`-associated inputs — second genuine DOB positive.",
        )
    )

    pan_prefix3 = "".join(rng.choices("ABCDEFGHIJKLMNPQRSTUVWXYZ", k=3))
    pan_holder_type = rng.choice("ABCPFGHLTJ")
    pan_letter5 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan_digits = "".join(str(rng.randint(0, 9)) for _ in range(4))
    pan_letter2 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan = pan_prefix3 + pan_holder_type + pan_letter5 + pan_digits + pan_letter2
    base2 = random_aadhaar_base(rng)
    aadhaar2 = base2 + verhoeff_generate(base2)
    pan_box = (220, 120, 130, 22)
    aad2_box = (220, 160, 160, 22)
    fixtures.append(
        Fixture(
            "gov-016", "gov", "gov", "PAN-Aadhaar Linking",
            '<div class="heading">PAN-Aadhaar Linking</div>'
            + field_html("PAN", pan, pan_box, "pan")
            + field_html("Aadhaar number", aadhaar2, aad2_box, "aadhaar"),
            [
                LabelItem("PAN", pan_box, sha256_hash(pan)),
                LabelItem("AADHAAR", aad2_box, sha256_hash(aadhaar2)),
            ],
            notes="PAN-Aadhaar linking page: both identifiers on one screen.",
        )
    )

    name4 = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(
        rng.choices("abcdefghijklmnopqrstuvwxyz", k=6)
    )
    pan_prefix3b = "".join(rng.choices("ABCDEFGHIJKLMNPQRSTUVWXYZ", k=3))
    pan_holder_typeb = rng.choice("ABCPFGHLTJ")
    pan_letter5b = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan_digitsb = "".join(str(rng.randint(0, 9)) for _ in range(4))
    pan_letter2b = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    panb = pan_prefix3b + pan_holder_typeb + pan_letter5b + pan_digitsb + pan_letter2b
    state = f"{rng.randint(1, 37):02d}"
    prefix14 = state + panb + "1" + "Z"
    check = gstin_generate(prefix14)
    gstin = prefix14 + check
    name4_box = (220, 120, 200, 22)
    gstin_box = (220, 160, 150, 22)
    fixtures.append(
        Fixture(
            "gov-017", "gov", "gov", "GST Registration",
            '<div class="heading">GST Registration</div>'
            + field_html("Applicant name", name4, name4_box, "name")
            + field_html("GSTIN", gstin, gstin_box, "gstin"),
            [
                LabelItem("PERSON_NAME", name4_box, sha256_hash(name4.lower())),
                LabelItem("GSTIN", gstin_box, sha256_hash(gstin)),
            ],
            notes="GST registration page: applicant name and GSTIN — bumping GSTIN's n.",
        )
    )

    name5 = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(
        rng.choices("abcdefghijklmnopqrstuvwxyz", k=6)
    )
    phone = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    name5_box = (220, 120, 200, 22)
    phone_box = (220, 160, 200, 22)
    fixtures.append(
        Fixture(
            "gov-018", "gov", "gov", "Property Tax Payment",
            '<div class="heading">Property Tax Payment</div>'
            + field_html("Owner name", name5, name5_box, "name")
            + field_html("Registered mobile", phone, phone_box, "phone"),
            [
                LabelItem("PERSON_NAME", name5_box, sha256_hash(name5.lower())),
                LabelItem("PHONE", phone_box, sha256_hash(phone.replace(" ", "").replace("+", ""))),
            ],
            notes="Municipal property-tax payment page: owner name and registered mobile.",
        )
    )

    return fixtures


def build_bank_extra4(rng: random.Random) -> list[Fixture]:
    """More banking pages beyond `bank-001..009` — corpus growth pass 5."""
    fixtures = []

    bank_account = random_bank_account(rng)
    bank_code = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=4))
    ifsc = bank_code + "0" + "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", k=6))
    acct_box = (220, 120, 180, 22)
    ifsc_box = (220, 160, 130, 22)
    fixtures.append(
        Fixture(
            "bank-010", "banking", "bank", "Fixed Deposit Creation",
            '<div class="heading">Fixed Deposit Creation</div>'
            + field_html("Source account", bank_account, acct_box, "acct")
            + field_html("IFSC", ifsc, ifsc_box, "ifsc"),
            [
                LabelItem("BANK_ACCOUNT", acct_box, sha256_hash(bank_account)),
                LabelItem("IFSC", ifsc_box, sha256_hash(ifsc)),
            ],
            notes="Fixed-deposit-creation form: source account and IFSC.",
        )
    )

    pan_prefix3 = "".join(rng.choices("ABCDEFGHIJKLMNPQRSTUVWXYZ", k=3))
    pan_holder_type = rng.choice("ABCPFGHLTJ")
    pan_letter5 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan_digits = "".join(str(rng.randint(0, 9)) for _ in range(4))
    pan_letter2 = rng.choice("ABCDEFGHIJKLMNPQRSTUVWXYZ")
    pan = pan_prefix3 + pan_holder_type + pan_letter5 + pan_digits + pan_letter2
    phone = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    pan_box = (220, 120, 130, 22)
    phone_box = (220, 160, 200, 22)
    fixtures.append(
        Fixture(
            "bank-011", "banking", "bank", "Credit Card Application",
            '<div class="heading">Credit Card Application</div>'
            + field_html("PAN", pan, pan_box, "pan")
            + field_html("Contact number", phone, phone_box, "phone"),
            [
                LabelItem("PAN", pan_box, sha256_hash(pan)),
                LabelItem("PHONE", phone_box, sha256_hash(phone.replace(" ", "").replace("+", ""))),
            ],
            notes="Credit-card-application form: PAN and contact number.",
        )
    )

    bank_account2 = random_bank_account(rng)
    name = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(
        rng.choices("abcdefghijklmnopqrstuvwxyz", k=6)
    )
    acct2_box = (220, 120, 180, 22)
    name_box = (220, 160, 200, 22)
    fixtures.append(
        Fixture(
            "bank-012", "banking", "bank", "Loan EMI Setup",
            '<div class="heading">Loan EMI Setup</div>'
            + field_html("Debit account", bank_account2, acct2_box, "acct")
            + field_html("Account holder", name, name_box, "name"),
            [
                LabelItem("BANK_ACCOUNT", acct2_box, sha256_hash(bank_account2)),
                LabelItem("PERSON_NAME", name_box, sha256_hash(name.lower())),
            ],
            notes="Loan-EMI-mandate-setup form: debit account and account-holder name.",
        )
    )

    handle = "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=7))
    vpa = f"{handle}@ybl"
    name2 = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(
        rng.choices("abcdefghijklmnopqrstuvwxyz", k=6)
    )
    vpa_box = (220, 120, 220, 22)
    name2_box = (220, 160, 200, 22)
    fixtures.append(
        Fixture(
            "bank-013", "banking", "bank", "UPI Autopay Mandate",
            '<div class="heading">UPI Autopay Mandate</div>'
            + field_html("Payer UPI ID", vpa, vpa_box, "vpa")
            + field_html("Payer name", name2, name2_box, "name"),
            [
                LabelItem("UPI_VPA", vpa_box, sha256_hash(vpa.lower())),
                LabelItem("PERSON_NAME", name2_box, sha256_hash(name2.lower())),
            ],
            notes="UPI autopay mandate setup: payer UPI ID (known handle ybl) and name.",
        )
    )

    return fixtures


def build_email_extra4(rng: random.Random) -> list[Fixture]:
    """More email pages beyond `email-001..006` — corpus growth pass 5."""
    fixtures = []

    reset_token = "".join(rng.choices("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", k=40))
    box = (220, 120, 780, 22)
    fixtures.append(
        Fixture(
            "email-007", "email", "email", "Password Reset Link",
            '<div class="heading">Password Reset Link</div>'
            + field_html("Reset link", f"https://example.test/reset?token={reset_token}", box, "link"),
            [LabelItem("SECRET", box, sha256_hash(f"https://example.test/reset?token={reset_token}"))],
            notes="A password-reset email containing a high-entropy reset token in the URL — a real-world SECRET shape (a bearer-style token), bumping SECRET's n.",
        )
    )

    email2 = "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=8)) + "@example.test"
    name = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(
        rng.choices("abcdefghijklmnopqrstuvwxyz", k=6)
    )
    email2_box = (220, 120, 260, 22)
    name_box = (220, 160, 200, 22)
    fixtures.append(
        Fixture(
            "email-008", "email", "email", "Invoice Notification",
            '<div class="heading">Invoice Notification</div>'
            + field_html("Billed to", email2, email2_box, "email")
            + field_html("Customer name", name, name_box, "name"),
            [
                LabelItem("EMAIL", email2_box, sha256_hash(email2.lower())),
                LabelItem("PERSON_NAME", name_box, sha256_hash(name.lower())),
            ],
            notes="Invoice-notification email: billed-to email and customer name.",
        )
    )

    email3 = "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=8)) + "@example.test"
    phone = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    email3_box = (220, 120, 260, 22)
    phone_box = (220, 160, 200, 22)
    fixtures.append(
        Fixture(
            "email-009", "email", "email", "Calendar Invite",
            '<div class="heading">Calendar Invite</div>'
            + field_html("Organizer", email3, email3_box, "email")
            + field_html("Dial-in number", phone, phone_box, "phone"),
            [
                LabelItem("EMAIL", email3_box, sha256_hash(email3.lower())),
                LabelItem("PHONE", phone_box, sha256_hash(phone.replace(" ", "").replace("+", ""))),
            ],
            notes="Calendar-invite email: organizer email and dial-in number.",
        )
    )

    return fixtures


def build_social_extra4(rng: random.Random) -> list[Fixture]:
    """More social-app pages beyond `social-001..008` — corpus growth pass 5."""
    fixtures = []

    username = "".join(rng.choices("abcdefghijklmnopqrstuvwxyz0123456789_", k=10))
    name = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(
        rng.choices("abcdefghijklmnopqrstuvwxyz", k=6)
    )
    user_box = (220, 120, 200, 22)
    name_box = (220, 160, 200, 22)
    fixtures.append(
        Fixture(
            "social-009", "social", "social", "Profile Settings",
            '<div class="heading">Profile Settings</div>'
            + field_html("Handle", username, user_box, "username")
            + field_html("Display name", name, name_box, "name"),
            [
                LabelItem("USERNAME", user_box, sha256_hash(username)),
                LabelItem("PERSON_NAME", name_box, sha256_hash(name.lower())),
            ],
            notes="Social-profile settings page: handle and display name.",
        )
    )

    phone = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    box2 = (16, 60, 340, 22)
    fixtures.append(
        Fixture(
            "social-010", "social", "social", "Direct Message",
            f'<div id="dm" style="position:absolute;left:{box2[0]}px;top:{box2[1]}px;">'
            f"Text me at {phone}, easier to reach</div>",
            [LabelItem("PHONE", box2, sha256_hash(phone.replace(" ", "").replace("+", "")))],
            notes="A DM-conversation-style page with a phone number shared in prose.",
        )
    )

    phone2 = "+91 " + str(rng.randint(6, 9)) + "".join(str(rng.randint(0, 9)) for _ in range(9))
    name2 = "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=1)) + "".join(
        rng.choices("abcdefghijklmnopqrstuvwxyz", k=6)
    )
    box3 = (16, 60, 260, 22)
    box4 = (16, 90, 340, 22)
    fixtures.append(
        Fixture(
            "social-011", "social", "social", "Marketplace Listing",
            f'<div id="seller" style="position:absolute;left:{box3[0]}px;top:{box3[1]}px;">'
            f"Sold by {name2}</div>"
            f'<div id="contact" style="position:absolute;left:{box4[0]}px;top:{box4[1]}px;">'
            f"WhatsApp {phone2} to buy</div>",
            [
                LabelItem("PERSON_NAME", box3, sha256_hash(name2.lower())),
                LabelItem("PHONE", box4, sha256_hash(phone2.replace(" ", "").replace("+", ""))),
            ],
            notes="A marketplace-listing-style page with seller name and phone number in prose.",
        )
    )

    email = "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=8)) + "@example.test"
    box5 = (16, 60, 300, 22)
    fixtures.append(
        Fixture(
            "social-012", "social", "social", "Comment Thread",
            f'<div id="cm" style="position:absolute;left:{box5[0]}px;top:{box5[1]}px;">'
            f"Reach the mods at {email}</div>",
            [LabelItem("EMAIL", box5, sha256_hash(email.lower()))],
            notes="A comment-thread-style page with an email mentioned in prose.",
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
    fixtures += build_identifiers_extra(rng)
    fixtures += build_hardneg_extra2(rng)
    fixtures += build_email_extra2(rng)
    fixtures += build_forms_extra(rng)
    fixtures += build_faces_extra2(rng)
    fixtures += build_canvas_extra2(rng)
    fixtures += build_pdf_extra2(rng)
    fixtures += build_indic_extra2(rng)
    fixtures += build_health_extra(rng)
    fixtures += build_gov_extra2(rng)
    fixtures += build_bank_extra2(rng)
    fixtures += build_freetext_extra(rng)
    fixtures += build_hardneg_extra3(rng)
    fixtures += build_identifiers_extra3(rng)
    fixtures += build_canvas_extra3(rng)
    fixtures += build_pdf_extra3(rng)
    fixtures += build_social_extra3(rng)
    fixtures += build_email_extra3(rng)
    fixtures += build_bank_extra3(rng)
    fixtures += build_gov_extra3(rng)
    fixtures += build_health_extra2(rng)
    fixtures += build_forms_extra2(rng)
    fixtures += build_faces_extra3(rng)
    fixtures += build_indic_extra3(rng)
    fixtures += build_coverage_extra(rng)
    fixtures += build_identifiers_extra4(rng)
    fixtures += build_hardneg_extra4(rng)
    fixtures += build_forms_extra3(rng)
    fixtures += build_faces_extra4(rng)
    fixtures += build_freetext_extra2(rng)
    fixtures += build_canvas_extra4(rng)
    fixtures += build_pdf_extra4(rng)
    fixtures += build_indic_extra4(rng)
    fixtures += build_health_extra3(rng)
    fixtures += build_gov_extra4(rng)
    fixtures += build_bank_extra4(rng)
    fixtures += build_email_extra4(rng)
    fixtures += build_social_extra4(rng)
    plant_canaries(fixtures, rng)
    return fixtures


def main() -> None:
    # Wipe both corpus roots before regenerating, not just mkdir: a screen_id's split assignment
    # (is_heldout) is stable, but the corpus directories themselves are not otherwise
    # self-cleaning — the generator has always only ever added/overwritten, never removed, a
    # stale directory (the same class of staleness a previous pass found and fixed by hand for a
    # renumbered hardneg-016). A full wipe-and-rebuild is what "idempotent" already claimed to be;
    # this makes it actually true for directory placement, not just file content.
    if CORPUS_DEV.exists():
        shutil.rmtree(CORPUS_DEV)
    if CORPUS_HELDOUT.exists():
        shutil.rmtree(CORPUS_HELDOUT)
    CORPUS_DEV.mkdir(parents=True, exist_ok=True)
    CORPUS_HELDOUT.mkdir(parents=True, exist_ok=True)
    LABELS_DIR.mkdir(parents=True, exist_ok=True)

    fixtures = generate_all()
    for fx in fixtures:
        fx.write()

    # Same staleness class for labels: delete any label file whose screen_id is no longer
    # produced by generate_all() — but never the schema itself, which isn't a fixture.
    current_ids = {fx.screen_id for fx in fixtures}
    for label_path in LABELS_DIR.glob("*.json"):
        if label_path.name == "label.schema.json":
            continue
        if label_path.stem not in current_ids:
            label_path.unlink()

    groups: dict[str, int] = {}
    heldout_count = 0
    for fx in fixtures:
        groups[fx.group] = groups.get(fx.group, 0) + 1
        if is_heldout(fx.screen_id):
            heldout_count += 1
    print(
        f"[generate_fixtures] wrote {len(fixtures)} fixtures "
        f"({len(fixtures) - heldout_count} dev / {heldout_count} heldout): {groups}"
    )

    # Label boxes above are element boxes; re-measure text values to their own glyphs (what the
    # client redacts — the phone number, not the sentence it sits in).
    print_totals(refine_labels(["dev", "heldout"]))


if __name__ == "__main__":
    main()

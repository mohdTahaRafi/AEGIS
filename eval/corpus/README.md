# eval/corpus

Labelled screens for the evaluation harness (design.md §18.1, FR-51).

## Layout

```
eval/corpus/<split>/<screen_id>/
  page/              # saved page — index.html + assets, or a render.py script
  screenshot.png     # reference render at the labelled viewport
  meta.json          # category, script, viewport, source, licence, notes
eval/labels/<screen_id>.json   # ground truth — see eval/labels/README.md
```

`<split>` is `dev` or `heldout`. `<screen_id>` matches `^[a-z]+-[0-9]{3,4}$` and is shared between
the corpus folder and its label file.

## `meta.json` shape

```jsonc
{
  "category": "banking",           // page.category enum from the protocol schema
  "group": "identifiers",          // fixture-purpose group, see below
  "script": "latin",                // or "devanagari"
  "viewport": [1280, 720],
  "source": "hand-built",           // hand-built | frozen-capture | live-panel
  "licence": "synthetic — no real data",
  "notes": "Aadhaar enrolment confirmation page, fictitious identity"
}
```

Every identifier in the corpus is **synthetic with a valid checksum** and fictitious (design.md
§17) — never a real person's data. Face images need a licence that permits this use, recorded per
image here in this file when added.

## Fixture groups (Phase 1 target: ~30 screens, per
[../../docs/planning/phase_1_contract_harness.md](../../docs/planning/phase_1_contract_harness.md) §5.3)

| Group | Count | Contents |
|---|---|---|
| `identifiers` | 8 | Aadhaar (grouped/ungrouped, valid Verhoeff), PAN, GSTIN, IFSC, UPI VPA, card (valid Luhn), Indian mobile, email — each with its label in context |
| `hardneg` | 8 | Look-alikes that must **not** be redacted: Verhoeff-failing 12-digit tracking ids, Luhn-failing 16-digit order numbers, PAN-shaped catalogue codes, prices, out-of-context dates, a 6-digit non-PIN number |
| `forms` | 4 | Login/payment forms: filled password field, OTP field, `cc-number`+`cc-csc`, a KYC form |
| `faces` | 4 | Profile avatar, ID-card image, signature image, QR code |
| `freetext` | 3 | Names/addresses in prose, a chat transcript, a profile page |
| `canvas` | 1 | Canvas-rendered form |
| `pdf` | 1 | PDF.js viewer page |
| `indic` | 1 | Devanagari text incl. Devanagari digits |

This distribution is deliberately weighted toward the cases that are hardest and most decisive —
NFR-3's false-redaction budget (<2% on hard negatives) is unmeasurable without the `hardneg` group,
and AC-11 is a direct acceptance criterion about it.

Phase 5 grows this to 200–300 screens across the full ten categories from the strategy (government
portals, banking, email/chat, social, healthcare, canvas apps, PDF.js viewers, video/camera
previews, Indic-script pages, hard negatives), 80% `dev` / 20% `heldout`.

## Held-out discipline

`heldout/` is touched **once**, before submission, only via the runner's explicit
`--i-am-really-using-heldout --reason "..."` flags (design.md §18.4). Do not open it casually —
even reading it and mentally noting what's in it erodes the split.

## Canaries

Every fixture plants at least one unique high-entropy string, recorded in its label file
(`canary: true`, `canary_id: "<the string>"`). If a canary ever appears in a captured outbound
payload — JSON bytes or OCR of a sanitized image — that is a leak, full stop, and is what makes the
guard's canary check (design.md §7.6 step 6, wired into CI from Phase 5) meaningful rather than
theoretical.

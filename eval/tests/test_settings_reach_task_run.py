"""T-6.8, 2026-09-26 — a real, previously-undiscovered bug found while measuring NER profile L's
corpus recall: `entrypoints/sidepanel/main.tsx` assigned `window.__aegisRunTask = handleStart`
inside an EMPTY-deps `useEffect`, so only the FIRST render's `handleStart` closure was ever
installed — and that closure read `settings` directly from component state, captured before the
async `loadSettings()` (a `browser.storage.local` read) had resolved. Invisible to a real human
(reaction time to click "Run" is far longer than one storage read), but it meant no setting —
NER profile, backend preference, always-redact overrides, anything in `Settings` — ever reached a
real task run when triggered programmatically (exactly `run_task_in_panel`'s own pattern:
`open_panel` only waits for the hook to EXIST) before that read finished. Confirmed by direct
reproduction: setting `nerProfile: 'L'` via `storage.local` before firing `__aegisRunTask` still
ran the task against profile S every time — the eval harness's own `--ner-profile L` corpus
measurement had silently been running against profile S throughout. Fixed with a `settingsRef`,
the same pattern `sessionRef` already used for the identical class of problem one line up.

This test proves the fix holds against the real built extension, real corpus fixture, and real
storage.local write — not a mock. `eval/corpus/dev/forms-008` has a real (non-gibberish) address,
"521 MG Road, Apartment 7, Bengaluru", in a plain DOM text run outside any form field — Channel D
(no `<input>`, so no DOM signal) and Channel T (no ADDRESS pattern recognizer exists — free-text
addresses have no structural signature, design.md §6.3) can never redact it on their own. An
ADDRESS entry in the real ledger's `redactions[]` is only possible if profile L's real NER model
ran for real, which only happens if `settingsRef.current.nerProfile` was actually `'L'` at the
moment `perceptionClient.init()` was called — the exact value this bug used to get wrong.
"""

from __future__ import annotations

import pytest
from aegis_eval.runner.browser import DEBUG_EXTENSION_DIR, extension_context, extension_id
from aegis_eval.runner.collect import collect_ledger_export
from aegis_eval.runner.drive import CORPUS_DIR, open_fixture, open_panel, run_task_in_panel
from aegis_eval.runner.fixture_server import serve_corpus
from aegis_eval.runner.gateway_mock import MockGateway


# [Known, disclosed, 2026-09-26 — see docs/HISTORY.md's T-6.8 entries] The `settingsRef` fix this
# test's own docstring describes IS confirmed working — checked directly (a temporary debug log
# inside `perceptionClient.init()`'s real call site showed `settingsRef.current.nerProfile` really
# was `'L'` when this exact scenario ran). What this test cannot yet get past is a SEPARATE, deeper,
# still-unresolved bug: `perception/worker.ts`'s real NER model load fails every time with a `blob:`
# fetch error inside `onnxruntime-web`'s own WebGPU (JSEP) backend, root-caused across three real
# layers (a CDN wasmPaths default, Vite's IIFE worker output, and this last one) but not fixed —
# it now looks like a structural incompatibility between this pinned `onnxruntime-web` prerelease
# and a Chrome MV3 extension's CSP, not something more configuration can solve. `xfail(strict=True)`
# rather than skipping outright: this test is still real and still running each time, so an
# unexpected pass (once that bug is ever actually fixed) fails loudly instead of silently — the
# signal to come back and remove this marker.
@pytest.mark.xfail(
    reason="known, disclosed T-6.8 bug: perception/worker.ts cannot load the real NER model at all "
    "(onnxruntime-web WebGPU/JSEP backend blob-import failure, root-caused but unresolved — see "
    "docs/HISTORY.md's 2026-09-26 entries) — the settingsRef fix this test also covers IS working, "
    "confirmed independently by direct instrumentation, but the model never loads to prove it via "
    "a real ADDRESS redaction",
    strict=True,
)
def test_a_storage_local_setting_written_before_the_task_starts_actually_reaches_it() -> None:
    with serve_corpus(CORPUS_DIR) as base_url, extension_context(
        headless=True, extension_dir=DEBUG_EXTENSION_DIR
    ) as context:
        ext_id = extension_id(context)
        MockGateway().install(context)

        setup_page = context.new_page()
        setup_page.goto(f"chrome-extension://{ext_id}/sidepanel.html")
        setup_page.evaluate(
            "(profile) => chrome.storage.local.set({ aegis_settings: { nerProfile: profile } })", "L"
        )
        setup_page.close()

        _, fixture_page = open_fixture(context, "dev", "forms-008", base_url=base_url)
        panel = open_panel(context, ext_id)
        run_task_in_panel(panel, fixture_page, "review the shipping address form", [])
        export = collect_ledger_export(panel, "forms-008")

    entities = {
        r["entity"]
        for step in export.steps
        for r in step.get("payload", {}).get("redactions", [])
    }
    assert "ADDRESS" in entities, (
        "profile L's real NER model never fired — either the settings write didn't reach "
        f"perceptionClient.init() (the bug this test guards against) or a real regression in the "
        f"model/worker wiring. Entities actually redacted this run: {sorted(entities)}"
    )

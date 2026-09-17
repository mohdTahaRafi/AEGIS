"""Playwright-driven harness runner (design.md §12.3, phase_1_contract_harness.md §5.4).

Phase 1 scope: prove the loop closes — launch Chromium with the unpacked extension loaded, open
every dev-split fixture, obtain a (currently empty) ledger export, sample resources, write a
report row. No assertions about product behaviour; there is no product behaviour yet.
"""

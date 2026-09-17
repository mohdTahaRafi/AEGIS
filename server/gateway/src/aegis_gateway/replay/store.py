"""design.md §12.1/§6.6 (T-2.39) — record/replay, keyed by
`sha256(canonical request without timing fields)`. This is the demo-reliability mechanism (the
fallback when conference wifi or a rented GPU fails) and what lets the Phase 5 harness run
deterministically.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

# Varies between otherwise-identical requests but carries no decision-relevant content — stripped
# before hashing so record/replay still matches even though real client timings differ every run.
_EXCLUDED_KEYS = {"client_timing"}


def canonical_key(step_request: dict) -> str:
    stripped = {k: v for k, v in step_request.items() if k not in _EXCLUDED_KEYS}
    canonical = json.dumps(stripped, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


class ReplayStore:
    def __init__(self, directory: str) -> None:
        self._dir = Path(directory)

    def _path_for(self, key: str) -> Path:
        return self._dir / f"{key}.json"

    def record(self, step_request: dict, plan: dict) -> None:
        self._dir.mkdir(parents=True, exist_ok=True)
        self._path_for(canonical_key(step_request)).write_text(json.dumps(plan))

    def lookup(self, step_request: dict) -> dict | None:
        path = self._path_for(canonical_key(step_request))
        if not path.exists():
            return None
        return json.loads(path.read_text())

    def is_loaded(self) -> bool:
        return self._dir.exists() and any(self._dir.glob("*.json"))

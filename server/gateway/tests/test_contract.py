"""
T-1.7: every sample in packages/protocol/test/contract/samples/manifest.json produces the same
verdict -- and, for violations, the same named field -- on both the Pydantic models here and the
TypeScript validators (see roundtrip.spec.ts in packages/protocol). Run together they prove the
contract, not just this half of it.
"""

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel, ValidationError

from aegis_gateway.protocol.action_plan import ActionPlan
from aegis_gateway.protocol.error import ErrorResponse
from aegis_gateway.protocol.sanitized_context import SanitizedContext
from aegis_gateway.protocol.session import SessionCreate, SessionCreated

SAMPLES_DIR = (
    Path(__file__).resolve().parents[3] / "packages" / "protocol" / "test" / "contract" / "samples"
)

MODELS: dict[str, type[BaseModel]] = {
    "sanitizedContext": SanitizedContext,
    "actionPlan": ActionPlan,
    "errorResponse": ErrorResponse,
    "sessionCreate": SessionCreate,
    "sessionCreated": SessionCreated,
}


def _manifest() -> dict[str, Any]:
    with open(SAMPLES_DIR / "manifest.json") as f:
        return json.load(f)


def _load(relpath: str) -> Any:
    with open(SAMPLES_DIR / relpath) as f:
        return json.load(f)


def _loc_contains(errors: list[dict[str, Any]], needle: str) -> bool:
    return any(needle in [str(part) for part in err["loc"]] for err in errors)


@pytest.mark.parametrize("entry", _manifest()["valid"], ids=lambda e: e["file"])
def test_valid_samples_validate(entry: dict[str, Any]) -> None:
    model = MODELS[entry["schema"]]
    data = _load(entry["file"])
    try:
        model.model_validate(data)
    except ValidationError as exc:
        pytest.fail(f"expected valid, got errors: {exc.errors()}")


@pytest.mark.parametrize("entry", _manifest()["violation"], ids=lambda e: e["file"])
def test_violation_samples_rejected_naming_expected_field(entry: dict[str, Any]) -> None:
    model = MODELS[entry["schema"]]
    data = _load(entry["file"])
    expect = entry["pydantic"]

    with pytest.raises(ValidationError) as excinfo:
        model.model_validate(data)

    errors = excinfo.value.errors()
    matching_type = [e for e in errors if e["type"] == expect["type"]]
    assert matching_type, (
        f"expected an error of type {expect['type']!r} for {entry['file']}, got "
        f"{[e['type'] for e in errors]}"
    )
    assert _loc_contains(matching_type, expect["locContains"]), (
        f"expected an error whose loc contains {expect['locContains']!r} for {entry['file']}, "
        f"got locs {[e['loc'] for e in matching_type]}"
    )

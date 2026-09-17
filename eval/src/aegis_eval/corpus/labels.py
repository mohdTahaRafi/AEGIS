"""Label file loading and validation against eval/labels/label.schema.json (design.md §18.1)."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import jsonschema

REPO_ROOT = Path(__file__).resolve().parents[4]
LABELS_DIR = REPO_ROOT / "eval" / "labels"
CORPUS_DIR = REPO_ROOT / "eval" / "corpus"
SCHEMA_PATH = LABELS_DIR / "label.schema.json"


@dataclass
class LabelValidationError:
    file: Path
    message: str


def _load_schema() -> dict:
    with open(SCHEMA_PATH) as f:
        return json.load(f)


def validate_label_file(path: Path, schema: dict | None = None) -> list[str]:
    """Returns a list of human-readable validation error messages; empty if valid."""
    schema = schema or _load_schema()
    with open(path) as f:
        data = json.load(f)

    validator = jsonschema.Draft202012Validator(schema)
    errors = sorted(validator.iter_errors(data), key=lambda e: list(e.path))
    return [f"{'/'.join(str(p) for p in e.path) or '<root>'}: {e.message}" for e in errors]


def iter_label_files() -> list[Path]:
    if not LABELS_DIR.exists():
        return []
    return sorted(p for p in LABELS_DIR.glob("*.json") if p.name != "label.schema.json")


def canary_ids_are_globally_unique(files: list[Path]) -> list[str]:
    """Returns error messages if any canary_id is reused across more than one label file."""
    seen: dict[str, Path] = {}
    errors: list[str] = []
    for path in files:
        with open(path) as f:
            data = json.load(f)
        for item in data.get("items", []):
            cid = item.get("canary_id")
            if not cid:
                continue
            if cid in seen and seen[cid] != path:
                errors.append(f"canary_id {cid!r} reused in {path.name} and {seen[cid].name}")
            else:
                seen[cid] = path
    return errors


def screen_id_matches_folder(path: Path) -> str | None:
    """Returns an error message if the label's screen_id doesn't correspond to an existing
    corpus/<split>/<screen_id>/ folder in either split."""
    with open(path) as f:
        data = json.load(f)
    screen_id = data.get("screen_id")
    if screen_id is None:
        return None  # schema validation already reports the missing field
    for split in ("dev", "heldout"):
        if (CORPUS_DIR / split / screen_id).is_dir():
            return None
    return f"{path.name}: screen_id {screen_id!r} has no corpus/dev/ or corpus/heldout/ folder"

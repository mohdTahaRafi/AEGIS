# eval/labels

Ground truth for the evaluation corpus, one JSON file per `screen_id`, matching
`../corpus/<split>/<screen_id>/`. Shape is `label.schema.json` (design.md §18.1); validate any
file with:

```bash
uv run aegis-eval validate-labels
```

Values are stored as `value_hash` (sha256 of the canonical value — digits-only for numeric ids,
lowercased for email/VPA), never plaintext. This is what lets the harness's independent auditor
check for leaks in captured payloads without the corpus itself being a plaintext PII store.
`entity: "NONE"` marks a hard negative — an item that must **not** be detected as sensitive — and
requires a `note` explaining what it mimics. `canary: true` items carry their tripwire string in
plaintext (`canary_id`), because a canary's only job is to be searched for verbatim.

# Contributing

## Branches

- `main` is always buildable and is never force-pushed.
- Work on a short-lived branch named `<type>/<short-topic>`, for example `fix/stop-during-confirm`
  or `feat/gemini-provider`, and merge it through a pull request.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <what changed, imperative, lower case, no full stop>

<why, if it is not obvious: the bug, the measurement, the decision>
```

| Type | Use for |
|---|---|
| `feat` | new behaviour a user or the model can see |
| `fix` | a bug fix |
| `refactor` | a code change with no behaviour change, including removing dead code |
| `perf` | faster or smaller, same behaviour |
| `test` | tests only |
| `docs` | documentation only |
| `build` | build scripts, release gates, manifest, dependencies |
| `ci` | `.github/workflows/` |
| `chore` | anything else that changes no shipped code (ignore files, tooling config) |

Scopes follow the repo layout: `content`, `host`, `agent`, `egress`, `privacy`, `perception`, `ui`
(the extension); `protocol`, `recognizers`, `policy` (packages); `gateway`, `eval`, `tools`, `demo`,
`docs`. Leave the scope out when a change spans several.

One commit is one logical change:

- a schema change goes in the same commit as its regenerated files (`pnpm gen:protocol`);
- regenerated corpus fixtures and labels go in one commit per regeneration, separate from the code
  change that caused them (`test(eval): regenerate dev corpus after PAN generator fix`);
- documentation that a change makes stale is updated in the same commit (`CLAUDE.md`: docs that
  disagree with the code are a defect).

## Before you push

```bash
pnpm lint && pnpm -r typecheck && pnpm -r test
(cd server/gateway && uv run pytest -q)     # if the gateway changed
```

A change to how the extension or the agent behaves also needs a visible run on a real site
(`CLAUDE.md` rule 8, [docs/guides/testing.md](docs/guides/testing.md)).

## AI agents

Agents working in this repo follow [CLAUDE.md](CLAUDE.md) / [AGENTS.md](AGENTS.md). They do not
commit or push; the team reviews and commits.

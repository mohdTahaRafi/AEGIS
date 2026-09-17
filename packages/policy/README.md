# @aegis/policy

Policy is data, not code (design.md §7.2). `policies/default.policy.json` holds sensitivity
classes, thresholds, operators, the entity→class map, the presence-only list and rehydration/risk
rules, validated against a schema at load. Every payload records the policy version.

**Empty scaffold — built in Phase 3.** See [docs/TASKS.md](../../docs/TASKS.md) T-3.6, T-3.7.

"""design.md §18.2, metric 5 — end-to-end latency. Per-stage p50/p95 from the ledger; per-step
round trip; per-task wall clock; model share from the gateway's `Server-Timing` header."""

from __future__ import annotations

from dataclasses import dataclass, field

from aegis_eval.scorers.metric4 import percentile

STAGES = ("observe", "perceive", "sanitize", "guard", "server", "validate", "act")


@dataclass
class StepTimings:
    observe: float
    perceive: float
    sanitize: float
    guard: float
    server: float
    validate: float
    act: float
    # ms of the step's own `server` time the gateway's `Server-Timing` header attributed to the
    # model call itself — absent when the header wasn't present (e.g. a replay-mode run, or an
    # older gateway build), never assumed to be the full `server` time.
    model_time_ms: float | None = None

    def total_ms(self) -> float:
        return sum(getattr(self, stage) for stage in STAGES)


@dataclass
class Metric5Result:
    n_steps: int
    n_tasks: int
    per_stage_p50: dict[str, float | None] = field(default_factory=dict)
    per_stage_p95: dict[str, float | None] = field(default_factory=dict)
    step_round_trip_p50_ms: float | None = None
    step_round_trip_p95_ms: float | None = None
    task_wall_clock_p50_ms: float | None = None
    task_wall_clock_p95_ms: float | None = None
    model_share_pct: float | None = None


def score_metric5(steps: list[StepTimings], task_wall_clock_ms: list[float]) -> Metric5Result:
    per_stage_values: dict[str, list[float]] = {stage: [] for stage in STAGES}
    for step in steps:
        for stage in STAGES:
            per_stage_values[stage].append(getattr(step, stage))

    per_stage_p50 = {stage: percentile(values, 50) for stage, values in per_stage_values.items()}
    per_stage_p95 = {stage: percentile(values, 95) for stage, values in per_stage_values.items()}

    round_trips = [step.total_ms() for step in steps]

    model_times = [s.model_time_ms for s in steps if s.model_time_ms is not None]
    server_times = [s.server for s in steps if s.model_time_ms is not None]
    model_share_pct = None
    if model_times and sum(server_times) > 0:
        model_share_pct = 100 * sum(model_times) / sum(server_times)

    return Metric5Result(
        n_steps=len(steps),
        n_tasks=len(task_wall_clock_ms),
        per_stage_p50=per_stage_p50,
        per_stage_p95=per_stage_p95,
        step_round_trip_p50_ms=percentile(round_trips, 50),
        step_round_trip_p95_ms=percentile(round_trips, 95),
        task_wall_clock_p50_ms=percentile(task_wall_clock_ms, 50),
        task_wall_clock_p95_ms=percentile(task_wall_clock_ms, 95),
        model_share_pct=model_share_pct,
    )

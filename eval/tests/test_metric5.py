from aegis_eval.scorers.metric5 import StepTimings, score_metric5


def make_step(**overrides) -> StepTimings:
    base = dict(observe=10, perceive=5, sanitize=5, guard=2, server=100, validate=3, act=10)
    base.update(overrides)
    return StepTimings(**base)


def test_per_stage_p50_over_multiple_steps() -> None:
    steps = [make_step(observe=10), make_step(observe=20), make_step(observe=30)]
    result = score_metric5(steps, task_wall_clock_ms=[])
    assert result.per_stage_p50["observe"] == 20


def test_round_trip_is_sum_of_all_stages() -> None:
    steps = [make_step()]
    result = score_metric5(steps, task_wall_clock_ms=[])
    assert result.step_round_trip_p50_ms == 10 + 5 + 5 + 2 + 100 + 3 + 10


def test_model_share_pct_uses_only_steps_with_a_server_timing_header() -> None:
    steps = [make_step(server=100, model_time_ms=71), make_step(server=50, model_time_ms=None)]
    result = score_metric5(steps, task_wall_clock_ms=[])
    assert result.model_share_pct == 71.0


def test_model_share_is_none_when_no_step_has_server_timing() -> None:
    steps = [make_step(model_time_ms=None)]
    result = score_metric5(steps, task_wall_clock_ms=[])
    assert result.model_share_pct is None


def test_task_wall_clock_percentiles() -> None:
    result = score_metric5([], task_wall_clock_ms=[1000, 2000, 3000])
    assert result.task_wall_clock_p50_ms == 2000
    assert result.n_tasks == 3

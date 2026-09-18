"""design.md §18.2 / phase_5_measurement.md T-5.9 — the rich scoreboard: all five metrics plus
leak count, each with its own explanation of what it means and — critically — an honest "not
measured, here's why" cell rather than a fabricated number when an input this sandboxed
environment cannot produce (a live model, reference hardware, a ground-truth screen graph) is
missing. Every numeric cell states its own n; nothing is silently averaged into a single "score."
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from aegis_eval.scorers.metric1 import PrimaryReading, SecondaryReading
from aegis_eval.scorers.metric2 import Metric2Result
from aegis_eval.scorers.metric3 import Metric3Result
from aegis_eval.scorers.metric4 import Metric4Result
from aegis_eval.scorers.metric5 import Metric5Result
from aegis_eval.scorers.leak import LeakCountResult


def _fmt(value: float | int | None, digits: int = 2, suffix: str = "") -> str:
    if value is None:
        return "— (not measured)"
    if isinstance(value, float):
        return f"{value:.{digits}f}{suffix}"
    return f"{value}{suffix}"


@dataclass
class Provenance:
    date: str
    split: str
    hardware: str
    browser: str
    browser_version: str
    backend: str | None
    policy_version: str | None
    model_versions: str | None


def render_provenance(p: Provenance) -> list[str]:
    return [
        f"- **date:** {p.date}",
        f"- **split:** {p.split}",
        f"- **hardware:** {p.hardware}",
        f"- **browser:** {p.browser} {p.browser_version}",
        f"- **backend:** {p.backend or '—'}",
        f"- **policy version:** {p.policy_version or '—'}",
        f"- **model versions:** {p.model_versions or '—'}",
        "",
    ]


def render_metric1(primary: PrimaryReading | None, secondary: SecondaryReading | None) -> list[str]:
    lines = ["## Metric 1 — Visual context accuracy (25%)", "", "OQ-4 leaves this ambiguous; both readings are reported.", ""]
    if primary is None:
        lines += ["**Primary (sanitized/raw task-success ratio): not measured** — requires two live-model runs (OQ-13 still open in this environment). No number is asserted in its place.", ""]
    else:
        lines += [
            f"**Primary:** sanitized {primary.sanitized_success_rate:.1%} ÷ raw {primary.raw_success_rate:.1%} "
            f"= {_fmt(primary.ratio, 3)}, n={primary.n_tasks} tasks",
            "",
        ]
    if secondary is None or secondary.element_agreement is None:
        lines += ["**Secondary (element-level agreement / screen-label accuracy): not measured** — the corpus's `eval/labels/*.json` format labels PII items, not full ground-truth screen graphs or screen-state labels (a forward dependency, not a bug).", ""]
    else:
        lines += [
            f"**Secondary:** element agreement {_fmt(secondary.element_agreement, 3)}, "
            f"screen-label accuracy {_fmt(secondary.screen_label_accuracy, 3)}, n={secondary.n_screens} screens",
            "",
        ]
    return lines


def render_metric2(result: Metric2Result | None) -> list[str]:
    lines = ["## Metric 2 — PII detection (20%)", ""]
    if result is None or result.n_screens == 0:
        lines += ["**Not measured** — no scored (prediction, ground-truth) pairs were supplied for this run.", ""]
        return lines
    lines += [
        f"n={result.n_screens} screens. IoU ≥ 0.5 (faces ≥ 0.4). Macro/micro precision-recall, "
        "three tables by difficulty (design.md §18.2):",
        "",
    ]
    for group_label, group_key in (("Structured", "structured"), ("Free-text", "free_text"), ("Visual", "visual")):
        lines += [
            f"**{group_label}** — macro P/R: {_fmt(result.macro_precision(group_key), 3)} / {_fmt(result.macro_recall(group_key), 3)}, "
            f"micro P/R: {_fmt(result.micro_precision(group_key), 3)} / {_fmt(result.micro_recall(group_key), 3)}",
            "",
            "| entity | TP | FP | FN | precision | recall |",
            "|---|---|---|---|---|---|",
        ]
        for entity, counts in sorted(result.per_entity.items()):
            from aegis_eval.scorers.entity_groups import group_of

            if group_of(entity) != group_key:
                continue
            lines.append(f"| {entity} | {counts.tp} | {counts.fp} | {counts.fn} | {_fmt(counts.precision, 3)} | {_fmt(counts.recall, 3)} |")
        lines.append("")
    return lines


def render_metric3(result: Metric3Result | None) -> list[str]:
    lines = ["## Metric 3 — Redaction precision (20%)", ""]
    if result is None or result.n_screens == 0:
        lines += ["**Not measured** — no scored screens supplied.", ""]
        return lines
    lines += [
        f"n={result.n_screens} screens, n={result.n_hard_negatives} hard negatives.",
        "",
        f"- pixel precision: {_fmt(result.pixel_precision, 3)}",
        f"- over-redaction rate on hard negatives: {_fmt(result.over_redaction_rate, 4)}",
        f"- mean IoU of matched boxes: {_fmt(result.mean_iou, 3)}",
        "",
    ]
    return lines


def render_metric4(result: Metric4Result | None) -> list[str]:
    lines = ["## Metric 4 — Client resources (20%)", ""]
    if result is None:
        lines += ["**Not measured.**", ""]
        return lines
    lines += [
        f"- bundled model MB: {_fmt(result.bundled_model_mb, 1)}",
        f"- task peak/mean RSS MB: {_fmt(result.task_peak_rss_mb, 1)} / {_fmt(result.task_mean_rss_mb, 1)}"
        + (" (not measured — needs a real driven task on reference hardware, OQ-16)" if result.task_peak_rss_mb is None else ""),
        f"- task CPU mean/p95 %: {_fmt(result.task_cpu_mean_pct, 1)} / {_fmt(result.task_cpu_p95_pct, 1)}",
        f"- idle CPU mean/p95 %: {_fmt(result.idle_cpu_mean_pct, 1)} / {_fmt(result.idle_cpu_p95_pct, 1)}",
        f"- GPU time: {_fmt(result.gpu_time_ms, 1, ' ms') if result.gpu_time_ms is not None else '— (not available)'}",
        "",
    ]
    return lines


def render_metric5(result: Metric5Result | None) -> list[str]:
    lines = ["## Metric 5 — End-to-end latency (15%)", ""]
    if result is None or result.n_steps == 0:
        lines += ["**Not measured** — needs real driven steps against a live gateway.", ""]
        return lines
    lines += [f"n={result.n_steps} steps, n={result.n_tasks} tasks.", "", "| stage | p50 ms | p95 ms |", "|---|---|---|"]
    for stage in result.per_stage_p50:
        lines.append(f"| {stage} | {_fmt(result.per_stage_p50[stage], 1)} | {_fmt(result.per_stage_p95[stage], 1)} |")
    lines += [
        "",
        f"- step round trip p50/p95: {_fmt(result.step_round_trip_p50_ms, 1)} / {_fmt(result.step_round_trip_p95_ms, 1)} ms",
        f"- task wall clock p50/p95: {_fmt(result.task_wall_clock_p50_ms, 1)} / {_fmt(result.task_wall_clock_p95_ms, 1)} ms",
        f"- model share of server time: {_fmt(result.model_share_pct, 1, '%')}",
        "",
    ]
    return lines


def render_leak_count(result: LeakCountResult | None) -> list[str]:
    lines = ["## Leak count", ""]
    if result is None:
        lines += ["**Not measured.**", ""]
        return lines
    lines += [
        f"**{result.leak_count}, n={result.n_payloads} payloads.**",
        "",
        "Recognizers written independently of the client's (T-5.7) — see `auditor/recognizers.py`."
        + (" OCR of composed images ran as part of this audit." if result.ocr_checked else " OCR of composed images did **not** run (no OCR model available — a disclosed gap, see `auditor/ocr.py`); this leak count covers JSON text only, not image pixels."),
        "",
    ]
    if result.recoveries:
        lines += ["| screen | step | kind | entity | evidence |", "|---|---|---|---|---|"]
        for screen_id, step_id, recovery_result in result.recoveries:
            for r in recovery_result.recoveries:
                lines.append(f"| {screen_id} | {step_id} | {r.kind} | {r.entity or '—'} | `{r.evidence}` |")
        lines.append("")
    return lines


def write_scoreboard(
    path,
    provenance: Provenance,
    metric1: tuple[PrimaryReading | None, SecondaryReading | None],
    metric2: Metric2Result | None,
    metric3: Metric3Result | None,
    metric4: Metric4Result | None,
    metric5: Metric5Result | None,
    leak: LeakCountResult | None,
    failures_section: list[str] | None = None,
) -> None:
    lines = [
        "# AEGIS evaluation scoreboard",
        "",
        *render_provenance(provenance),
        *render_metric1(*metric1),
        *render_metric2(metric2),
        *render_metric3(metric3),
        *render_metric4(metric4),
        *render_metric5(metric5),
        *render_leak_count(leak),
    ]
    if failures_section:
        lines += ["## Failures", ""] + failures_section
    lines += ["", f"_Generated {datetime.now(UTC).isoformat()}_"]
    path.write_text("\n".join(lines) + "\n")

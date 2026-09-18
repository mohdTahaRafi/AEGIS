"""OS-level resource sampling (T-1.19). Samples the browser's own OS processes from the harness
side — never via the extension's `debugger` permission, which architecture.md §10.4 refuses to
grant (a measurement instrument that widens the extension's own trust surface would not be
measuring the shipped product). Uses psutil against the PID Playwright's persistent context
launches, walking child processes (Chromium is multi-process: browser, renderer, GPU, extension
service worker each get their own PID)."""

from __future__ import annotations

import time
from dataclasses import dataclass, field

import psutil


@dataclass
class ResourceSample:
    peak_rss_mb: float
    mean_rss_mb: float
    peak_cpu_pct: float
    mean_cpu_pct: float
    n_samples: int
    n_processes: int
    # Phase 5, T-5.5: design.md §18.2 wants CPU p95 as well as mean/peak, which needs the raw
    # series, not just the two aggregates above. Added as extra fields (not a breaking change to
    # the four aggregates every existing caller already reads) so `scorers/metric4.py` can compute
    # a percentile without this module knowing what a percentile is.
    rss_samples_mb: list[float] = field(default_factory=list)
    cpu_samples_pct: list[float] = field(default_factory=list)


def merge_samples(samples: list[ResourceSample]) -> ResourceSample | None:
    """Phase 5, T-5.5: pools every per-fixture `ResourceSample`'s raw series into one overall
    task-level sample, rather than averaging the per-fixture aggregates (which would understate
    the true peak and distort any percentile computed downstream — `scorers/metric4.py`'s CPU p95
    needs the real pooled distribution, not a mean of maxima)."""
    if not samples:
        return None
    rss_pool = [v for s in samples for v in s.rss_samples_mb]
    cpu_pool = [v for s in samples for v in s.cpu_samples_pct]
    if not rss_pool:
        return None
    return ResourceSample(
        peak_rss_mb=max(rss_pool),
        mean_rss_mb=sum(rss_pool) / len(rss_pool),
        peak_cpu_pct=max(cpu_pool) if cpu_pool else 0.0,
        mean_cpu_pct=sum(cpu_pool) / len(cpu_pool) if cpu_pool else 0.0,
        n_samples=len(rss_pool),
        n_processes=max((s.n_processes for s in samples), default=0),
        rss_samples_mb=rss_pool,
        cpu_samples_pct=cpu_pool,
    )


def find_browser_root_pid(extension_dir_marker: str) -> int | None:
    """Finds the Chromium root process by its `--load-extension=` argument rather than reaching
    into Playwright's private internals (a persistent context's Python object doesn't expose the
    OS pid through a stable public API). `extension_dir_marker` should be the extension directory
    path used to launch it — unique enough in practice not to collide with an unrelated Chromium
    process on the same machine. Returns the process with no parent among the matches (the
    browser's own root, as opposed to its renderer/GPU/utility child processes, which inherit the
    same command-line flags on some Chromium versions)."""
    candidates: list[psutil.Process] = []
    for proc in psutil.process_iter(["pid", "cmdline"]):
        try:
            cmdline = proc.info["cmdline"] or []
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
        if any(extension_dir_marker in arg for arg in cmdline):
            candidates.append(proc)
    if not candidates:
        return None
    candidate_pids = {p.pid for p in candidates}
    for p in candidates:
        try:
            if p.ppid() not in candidate_pids:
                return p.pid
        except psutil.NoSuchProcess:
            continue
    return candidates[0].pid


def sample_process_tree(pid: int, duration_s: float = 1.0, interval_s: float = 0.1) -> ResourceSample:
    """Polls `pid` and all its descendants for `duration_s`, at `interval_s` intervals."""
    try:
        root = psutil.Process(pid)
    except psutil.NoSuchProcess:
        return ResourceSample(0, 0, 0, 0, 0, 0)

    rss_samples: list[float] = []
    cpu_samples: list[float] = []
    deadline = time.monotonic() + duration_s

    # Prime cpu_percent() — its first call always returns 0.0 (no prior interval to compare).
    procs = [root, *root.children(recursive=True)]
    for p in procs:
        try:
            p.cpu_percent(interval=None)
        except psutil.NoSuchProcess:
            pass

    while time.monotonic() < deadline:
        time.sleep(interval_s)
        try:
            procs = [root, *root.children(recursive=True)]
        except psutil.NoSuchProcess:
            break
        rss_total = 0.0
        cpu_total = 0.0
        for p in procs:
            try:
                rss_total += p.memory_info().rss / (1024 * 1024)
                cpu_total += p.cpu_percent(interval=None)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        rss_samples.append(rss_total)
        cpu_samples.append(cpu_total)

    if not rss_samples:
        return ResourceSample(0, 0, 0, 0, 0, len(procs))

    return ResourceSample(
        peak_rss_mb=max(rss_samples),
        mean_rss_mb=sum(rss_samples) / len(rss_samples),
        peak_cpu_pct=max(cpu_samples),
        mean_cpu_pct=sum(cpu_samples) / len(cpu_samples),
        n_samples=len(rss_samples),
        n_processes=len(procs),
        rss_samples_mb=rss_samples,
        cpu_samples_pct=cpu_samples,
    )

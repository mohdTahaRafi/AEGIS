"""T-6.10 — a real fix, not a workaround, for a genuine pre-existing gap found while driving the
ablation runner against a real corpus fixture: `runner/drive.py` served every fixture page as a
`file://` URI, and Chrome extensions cannot be granted `file://` host access programmatically
(`chrome.permissions.request()` has no way to trigger the manual "Allow access to file URLs"
toggle a real user would flip in `chrome://extensions`). `captureVisibleTab()` throws
"Either the '<all_urls>' or 'activeTab' permission is required" for every such page — silently
swallowed by `entrypoints/sidepanel/main.tsx`'s own `captureVisibleTabAsBitmap()`, so the harness
never crashed, it just never actually exercised the vision/image path for ANY fixture, in ANY
phase, until this was found. A plain `http://127.0.0.1` origin is a normal, grantable origin —
this module serves `eval/corpus/` over one so the rest of the pipeline needs no changes at all."""

from __future__ import annotations

import functools
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class _QuietHandler(SimpleHTTPRequestHandler):
    """Same as `SimpleHTTPRequestHandler`, minus the default per-request stderr log line — a
    204-screen run would otherwise interleave hundreds of access-log lines into the harness's own
    `print()` progress output for no benefit."""

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002 (matches stdlib signature)
        pass


@contextmanager
def serve_corpus(corpus_dir: Path, host: str = "127.0.0.1", port: int = 0) -> Iterator[str]:
    """Serves `corpus_dir` over real HTTP for the lifetime of the `with` block and yields its
    base URL (e.g. `http://127.0.0.1:54321`). `port=0` (the default) asks the OS for a free port —
    a fixed port would risk colliding with a leftover process from an interrupted earlier run."""
    handler = functools.partial(_QuietHandler, directory=str(corpus_dir))
    server = ThreadingHTTPServer((host, port), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://{host}:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5.0)

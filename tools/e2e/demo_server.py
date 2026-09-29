"""Serves AEGIS/demo on :8080 for visible runs (probe_site.py --watch). Any path under /slow/ is
answered after 2.5 s, like a slow site, to show that a step waits for the new page to load.

    python3 tools/e2e/demo_server.py
"""

from __future__ import annotations

import functools
import http.server
import time
from pathlib import Path

DEMO = Path(__file__).resolve().parents[2] / "demo"
SLOW_S = 2.5


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path.startswith("/slow/"):
            time.sleep(SLOW_S)
            self.path = self.path[len("/slow") :]
        super().do_GET()

    def log_message(self, *args: object) -> None:
        pass


if __name__ == "__main__":
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 8080), functools.partial(Handler, directory=str(DEMO)))
    server.serve_forever()

"""design.md §12.1 (T-2.34) — `dict[session_id, Session]` with last-seen timestamps. Expiry is
lazy (checked on every `get()`), which alone satisfies the AC (a request against an expired
session gets `SESSION_NOT_FOUND`); `sweep_expired()` is the periodic housekeeping on top of that,
for sessions nobody ever queries again.

Also carries everything design.md §12.3's post-validation needs to check a plan against what was
actually sent — the union of node ids ever sent (minus any since removed), the affordances last
seen for each, every `redactions[].ref` ever sent, and the image regions from the last two steps.
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field


@dataclass
class Session:
    session_id: str
    model: str
    max_steps: int
    last_seen: float
    last_step_id: str | None = None
    step_count: int = 0
    sent_node_ids: set[str] = field(default_factory=set)
    node_affordances: dict[str, list[str]] = field(default_factory=dict)
    sent_refs: set[str] = field(default_factory=set)
    # (region, viewport_w, viewport_h) for up to the last 2 steps that carried an image.
    recent_image_regions: list[tuple[list[float], float, float]] = field(default_factory=list)

    def apply_step_context(
        self,
        step_id: str,
        nodes: list[dict],
        removed: list[str],
        redactions: list[dict],
        image_region: list[float] | None,
        viewport: dict,
    ) -> None:
        self.last_step_id = step_id
        self.step_count += 1
        for node in nodes:
            self.sent_node_ids.add(node["id"])
            self.node_affordances[node["id"]] = node.get("affordances", [])
        for node_id in removed:
            self.sent_node_ids.discard(node_id)
            self.node_affordances.pop(node_id, None)
        for redaction in redactions:
            ref = redaction.get("ref")
            if ref:
                self.sent_refs.add(ref)
        if image_region is not None:
            self.recent_image_regions.append((image_region, viewport["w"], viewport["h"]))
            del self.recent_image_regions[:-2]


class SessionStore:
    def __init__(self, ttl_s: int, now: Callable[[], float] = time.time) -> None:
        self._sessions: dict[str, Session] = {}
        self._ttl_s = ttl_s
        self._now = now

    def create(self, model: str, max_steps: int) -> Session:
        session_id = str(uuid.uuid4())
        session = Session(session_id=session_id, model=model, max_steps=max_steps, last_seen=self._now())
        self._sessions[session_id] = session
        return session

    def get(self, session_id: str) -> Session | None:
        session = self._sessions.get(session_id)
        if session is None:
            return None
        if self._now() - session.last_seen > self._ttl_s:
            del self._sessions[session_id]
            return None
        return session

    def touch(self, session_id: str) -> None:
        session = self._sessions.get(session_id)
        if session:
            session.last_seen = self._now()

    def delete(self, session_id: str) -> None:
        self._sessions.pop(session_id, None)

    def sweep_expired(self) -> int:
        now = self._now()
        expired = [sid for sid, s in self._sessions.items() if now - s.last_seen > self._ttl_s]
        for sid in expired:
            del self._sessions[sid]
        return len(expired)

    def __len__(self) -> int:
        return len(self._sessions)

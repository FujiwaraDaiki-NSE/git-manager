"""Strict agent event ingestion, append-only persistence, and projections.

Agent events are deliberately independent from Git observations.  A lifecycle
event can update only ``run_state``; a semantic status event must provide every
semantic field, including explicit ``null`` values used to clear a previous
value.  Projections order events by their occurrence time and then by the
database sequence, so late delivery is deterministic.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Mapping

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app import config

RunState = Literal["active", "idle", "interrupted", "ended"]
Phase = Literal["investigating", "implementing", "testing", "reviewing"]
Attention = Literal["waiting_for_user", "blocked", "review_required", "merge_ready"]
Outcome = Literal["completed", "stopped"]
Status = Literal[
    "investigating",
    "implementing",
    "testing",
    "reviewing",
    "waiting_for_user",
    "blocked",
    "review_required",
    "merge_ready",
    "completed",
    "stopped",
]
# Keep a descriptive alias for callers that do not need to know how the value
# is represented in the existing event columns.
AgentStatus = Status
LifecycleAction = Literal[
    "session_start", "subagent_start", "interrupt", "subagent_stop", "session_end"
]

STATUS_VALUES = frozenset(
    {
        "investigating",
        "implementing",
        "testing",
        "reviewing",
        "waiting_for_user",
        "blocked",
        "review_required",
        "merge_ready",
        "completed",
        "stopped",
    }
)


def status_fields(status: Status) -> dict[str, str | None]:
    """Map the compact MCP status onto the pre-existing event columns."""
    if status in {"investigating", "implementing", "testing", "reviewing"}:
        return {"run_state": "active", "phase": status, "attention": None, "outcome": None}
    if status in {"waiting_for_user", "blocked", "review_required", "merge_ready"}:
        return {"run_state": "idle", "phase": None, "attention": status, "outcome": None}
    if status == "completed":
        return {"run_state": "ended", "phase": None, "attention": None, "outcome": "completed"}
    if status == "stopped":
        return {"run_state": "ended", "phase": None, "attention": None, "outcome": "stopped"}
    raise ValueError("unknown status")


def task_key(project_id: str, branch: str) -> str:
    """Return the stable internal identity for one repository and branch."""
    return f"{project_id}\x1f{branch}"


class AgentEventRequest(BaseModel):
    """The wire contract accepted by REST and MCP report_agent_status."""

    model_config = ConfigDict(extra="forbid")

    event_id: str = Field(..., min_length=1, description="Caller-generated globally unique event ID")
    task_id: str = Field(..., min_length=1, description="Stable task or agent task identifier")
    worktree: str = Field(..., description="Exact absolute path of a known Git worktree")
    occurred_at: datetime = Field(..., description="Timezone-aware time at which the event occurred")
    kind: Literal["lifecycle", "status"] = Field(..., description="Lifecycle or explicit semantic status event")
    run_state: RunState = Field(..., description="Explicit runtime state")
    agent_id: str | None = Field(None, description="Optional agent identifier")
    action: LifecycleAction | None = Field(None, description="Lifecycle action; required only for lifecycle events")
    phase: Phase | None = Field(None, description="Explicit semantic phase, or null to clear it")
    attention: Attention | None = Field(None, description="Explicit user attention state, or null to clear it")
    outcome: Outcome | None = Field(None, description="Explicit outcome, or null to clear it")
    summary: str | None = Field(None, description="Explicit latest summary, or null to clear it")

    @field_validator("worktree")
    @classmethod
    def absolute_worktree(cls, value: str) -> str:
        if not os.path.isabs(value):
            raise ValueError("worktree must be an absolute path")
        return value

    @field_validator("occurred_at")
    @classmethod
    def timezone_aware(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("occurred_at must include a timezone")
        return value

    @model_validator(mode="after")
    def compatible_fields(self) -> "AgentEventRequest":
        semantic = {"phase", "attention", "outcome", "summary"}
        supplied = self.model_fields_set
        if self.kind == "lifecycle":
            if self.action is None:
                raise ValueError("lifecycle events require action")
            if semantic & supplied:
                raise ValueError("lifecycle events cannot set semantic fields")
            expected: dict[str, RunState] = {
                "session_start": "active",
                "subagent_start": "active",
                "interrupt": "interrupted",
                "subagent_stop": "idle",
                "session_end": "ended",
            }
            if self.run_state != expected[self.action]:
                raise ValueError("run_state is incompatible with lifecycle action")
        else:
            if self.action is not None:
                raise ValueError("status events cannot set action")
            if not {"phase", "attention", "outcome", "summary"} <= supplied:
                raise ValueError("status events must explicitly set phase, attention, outcome, and summary")
        return self


class ReportAgentStatusResponse(BaseModel):
    accepted: bool = Field(..., description="Whether the event was accepted")
    event_id: str = Field(..., description="Stored event ID")
    sequence: int = Field(..., description="Monotonic append sequence")
    idempotent: bool = Field(..., description="True when this event ID was already stored")
    snapshot: dict[str, Any] | None = Field(None, description="The accepted event snapshot")


_lock = threading.RLock()


class DuplicateEventConflict(ValueError):
    """The event ID exists but the caller supplied a different event."""


def db_path() -> Path:
    """Resolve the configured data directory at call time for test isolation."""
    return Path(os.environ.get("GITDASH_DATA_DIR", str(config.DATA_DIR))) / "agent-events.sqlite3"


def initialize() -> None:
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with _lock, sqlite3.connect(path) as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute(
            """CREATE TABLE IF NOT EXISTS agent_events (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id TEXT NOT NULL UNIQUE,
                task_id TEXT NOT NULL,
                agent_id TEXT,
                worktree TEXT NOT NULL,
                project_id TEXT,
                branch TEXT,
                occurred_at TEXT NOT NULL,
                observed_at REAL NOT NULL,
                kind TEXT NOT NULL,
                run_state TEXT NOT NULL,
                action TEXT,
                phase TEXT,
                attention TEXT,
                outcome TEXT,
                summary TEXT,
                payload TEXT NOT NULL
            )"""
        )
        db.execute("CREATE INDEX IF NOT EXISTS idx_agent_events_worktree ON agent_events(worktree, sequence)")
        db.execute("CREATE INDEX IF NOT EXISTS idx_agent_events_project ON agent_events(project_id, sequence)")


def _status_from_row(row: Mapping[str, Any]) -> str | None:
    """Read one row's explicit status without inheriting a previous event."""
    if row.get("kind") != "status":
        return None
    attention = row.get("attention")
    if isinstance(attention, str) and attention in {
        "waiting_for_user",
        "blocked",
        "review_required",
        "merge_ready",
    }:
        return attention
    phase = row.get("phase")
    if row.get("run_state") == "active" and isinstance(phase, str) and phase in {
        "investigating",
        "implementing",
        "testing",
        "reviewing",
    }:
        return phase
    outcome = row.get("outcome")
    if isinstance(outcome, str) and outcome in {"completed", "stopped"}:
        return outcome
    if isinstance(phase, str) and phase in {"investigating", "implementing", "testing", "reviewing"}:
        return phase
    return None


def _row(row: sqlite3.Row) -> dict[str, Any]:
    data = dict(row)
    data["status"] = _status_from_row(data)
    data.pop("payload", None)
    return data


def event_snapshot(row: Mapping[str, Any]) -> dict[str, Any]:
    """Return the raw event-shaped snapshot used by REST and SSE.

    In particular, a lifecycle event reports ``status: null`` even when an
    earlier explicit status exists for the same branch.  State consumers can
    use :func:`snapshots` when they need the latest explicit branch state.
    """
    status = row.get("status") if row.get("kind") == "status" else None
    if not isinstance(status, str) or status not in STATUS_VALUES:
        status = _status_from_row(row)
    if row.get("kind") != "status":
        status = None
    return {
        "event_id": row.get("event_id"),
        "task_id": row.get("task_id"),
        "agent_id": row.get("agent_id"),
        "worktree": row.get("worktree"),
        "project_id": row.get("project_id"),
        "branch": row.get("branch"),
        "occurred_at": row.get("occurred_at"),
        "observed_at": row.get("observed_at"),
        "sequence": row.get("sequence"),
        "kind": row.get("kind"),
        "run_state": row.get("run_state"),
        "action": row.get("action"),
        "phase": row.get("phase") if row.get("kind") == "status" else None,
        "attention": row.get("attention") if row.get("kind") == "status" else None,
        "outcome": row.get("outcome") if row.get("kind") == "status" else None,
        "summary": row.get("summary") if row.get("kind") == "status" else None,
        "status": status,
    }


def _epoch(value: str) -> float:
    return datetime.fromisoformat(value).astimezone(timezone.utc).timestamp()


def known_worktree(path: str, state: Mapping[str, Mapping[str, Any]]) -> Mapping[str, Any] | None:
    """Require the exact absolute path present in the observed state."""
    if not os.path.isabs(path):
        return None
    row = state.get(path)
    if isinstance(row, Mapping) and row.get("path", path) == path:
        return row
    return None


def append(request: AgentEventRequest, state: Mapping[str, Mapping[str, Any]]) -> ReportAgentStatusResponse:
    """Validate association, append once, and return the event snapshot."""
    associated = known_worktree(request.worktree, state)
    if associated is None:
        raise ValueError("unknown worktree")
    project_id = associated.get("common_dir")
    if not isinstance(project_id, str) or not project_id:
        project_id = request.worktree
    branch = associated.get("branch")
    branch = branch if isinstance(branch, str) and branch else None
    task_id = request.task_id
    occurred = request.occurred_at.astimezone(timezone.utc).isoformat()
    observed_at = datetime.now(timezone.utc).timestamp()
    payload = request.model_dump(mode="json")
    initialize()
    with _lock, sqlite3.connect(db_path()) as db:
        db.row_factory = sqlite3.Row
        existing = db.execute("SELECT * FROM agent_events WHERE event_id = ?", (request.event_id,)).fetchone()
        if existing is not None:
            event = _row(existing)
            try:
                existing_payload = json.loads(existing["payload"])
            except (TypeError, ValueError):
                existing_payload = None
            if existing_payload != payload:
                raise DuplicateEventConflict("event_id already exists with a different payload")
            return ReportAgentStatusResponse(
                accepted=True,
                event_id=request.event_id,
                sequence=int(event["sequence"]),
                idempotent=True,
                snapshot=event_snapshot(event),
            )
        cursor = db.execute(
            """INSERT INTO agent_events
            (event_id, task_id, agent_id, worktree, project_id, branch, occurred_at,
             observed_at, kind, run_state, action, phase, attention, outcome, summary, payload)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                request.event_id,
                task_id,
                request.agent_id,
                request.worktree,
                project_id,
                branch,
                occurred,
                observed_at,
                request.kind,
                request.run_state,
                request.action,
                request.phase if request.kind == "status" else None,
                request.attention if request.kind == "status" else None,
                request.outcome if request.kind == "status" else None,
                request.summary if request.kind == "status" else None,
                json.dumps(payload, ensure_ascii=False),
            ),
        )
        sequence = int(cursor.lastrowid)
        db.commit()
    event = {
        "event_id": request.event_id,
        "task_id": task_id,
        "agent_id": request.agent_id,
        "worktree": request.worktree,
        "project_id": project_id,
        "branch": branch,
        "occurred_at": occurred,
        "observed_at": observed_at,
        "sequence": sequence,
        "kind": request.kind,
        "run_state": request.run_state,
        "action": request.action,
        "phase": request.phase if request.kind == "status" else None,
        "attention": request.attention if request.kind == "status" else None,
        "outcome": request.outcome if request.kind == "status" else None,
        "summary": request.summary if request.kind == "status" else None,
    }
    # Caller publishes the SSE notification only after this function returns.
    return ReportAgentStatusResponse(
        accepted=True,
        event_id=request.event_id,
        sequence=sequence,
        idempotent=False,
        snapshot=event_snapshot(event),
    )


def events(*, project_id: str | None = None, worktree: str | None = None, as_of: datetime | None = None) -> list[dict[str, Any]]:
    initialize()
    query = "SELECT * FROM agent_events"
    values: list[Any] = []
    clauses: list[str] = []
    if project_id is not None:
        clauses.append("project_id = ?")
        values.append(project_id)
    if worktree is not None:
        clauses.append("worktree = ?")
        values.append(worktree)
    if as_of is not None:
        if as_of.tzinfo is None or as_of.utcoffset() is None:
            raise ValueError("as_of must include a timezone")
    if clauses:
        query += " WHERE " + " AND ".join(clauses)
    query += " ORDER BY sequence"
    with _lock, sqlite3.connect(db_path()) as db:
        db.row_factory = sqlite3.Row
        result = [_row(row) for row in db.execute(query, values).fetchall()]
    if as_of is not None:
        cutoff = as_of.astimezone(timezone.utc).timestamp()
        result = [row for row in result if _epoch(row["occurred_at"]) <= cutoff]
    return result


def projection(
    worktree: str,
    *,
    task_id: str | None = None,
    agent_id: str | None = None,
    state: Mapping[str, Mapping[str, Any]] | None = None,
    as_of: datetime | None = None,
) -> dict[str, Any] | None:
    rows = events(worktree=worktree, as_of=as_of)
    if task_id is not None:
        rows = [row for row in rows if row["task_id"] == task_id and row["agent_id"] == agent_id]
    if not rows:
        return None
    # Stable tie-breaking: occurrence time first, append sequence second.
    rows.sort(key=lambda row: (_epoch(row["occurred_at"]), int(row["sequence"])))
    current: dict[str, Any] = {
        "task_id": None, "agent_id": None, "worktree": worktree, "project_id": None,
        "branch": None, "run_state": None, "phase": None, "attention": None,
        "outcome": None, "summary": None, "occurred_at": None, "observed_at": None,
        "event_id": None, "sequence": None,
    }
    for row in rows:
        current.update({"task_id": row["task_id"], "agent_id": row["agent_id"], "project_id": row["project_id"], "branch": row["branch"], "run_state": row["run_state"], "occurred_at": row["occurred_at"], "observed_at": row["observed_at"], "event_id": row["event_id"], "sequence": row["sequence"]})
        if row["kind"] == "status":
            current.update({"phase": row["phase"], "attention": row["attention"], "outcome": row["outcome"], "summary": row["summary"]})
    return current


def snapshots(*, project_id: str, state: Mapping[str, Mapping[str, Any]], as_of: datetime | None = None) -> dict[str, dict[str, Any]]:
    """Return one latest explicit status for each repository/branch pair.

    Lifecycle rows remain available through :func:`project_events`, but they
    never create or replace a branch snapshot.  The event's worktree is kept
    as provenance; it is not the identity used for this projection.
    """
    result: dict[str, dict[str, Any]] = {}
    try:
        historical = events(project_id=project_id, as_of=as_of)
    except (OSError, sqlite3.Error):
        return result
    latest: dict[tuple[str, str], dict[str, Any]] = {}
    for event in historical:
        if event.get("kind") != "status":
            continue
        if event.get("status") not in STATUS_VALUES:
            continue
        branch = event.get("branch")
        event_project = event.get("project_id")
        if not isinstance(branch, str) or not branch or not isinstance(event_project, str):
            continue
        key = (event_project, branch)
        previous = latest.get(key)
        if previous is None:
            latest[key] = event
            continue
        if (_epoch(event["occurred_at"]), int(event["sequence"])) > (
            _epoch(previous["occurred_at"]),
            int(previous["sequence"]),
        ):
            latest[key] = event
    for (event_project, branch), event in latest.items():
        item = event_snapshot(event)
        item["task_id"] = task_key(event_project, branch)
        item["agent_id"] = None
        key = f"{event_project}\x1f{branch}"
        result[key] = item
    return result


def project_events(project_id: str, *, state: Mapping[str, Mapping[str, Any]], as_of: datetime | None = None) -> list[dict[str, Any]]:
    try:
        rows = events(project_id=project_id, as_of=as_of)
    except (OSError, sqlite3.Error):
        return []
    result: list[dict[str, Any]] = []
    for row in rows:
        result.append({
            "id": f"agent:{row['event_id']}", "event_id": row["event_id"], "occurred_at": row["occurred_at"],
            "observed_at": row["observed_at"], "sequence": row["sequence"], "type": "agent",
            "source": "agent", "project_id": row["project_id"], "worktree": row["worktree"],
            "branch": row["branch"], "lane_id": f"branch:{row['branch']}" if row["branch"] else f"worktree:{row['worktree']}",
            "task_id": row["task_id"], "agent_id": row["agent_id"], "kind": row["kind"], "run_state": row["run_state"],
            "phase": row["phase"], "attention": row["attention"], "outcome": row["outcome"], "summary": row["summary"],
            "status": row["status"],
        })
    return result

"""The single MCP tool exposed by gitdash."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Callable, Mapping

from mcp.server.fastmcp import FastMCP
from pydantic import Field

from app import agent_events

_state_provider: Callable[[], Mapping[str, Mapping[str, Any]]] = lambda: {}
_event_publisher: Callable[[dict[str, Any]], None] = lambda _event: None
_MISSING = object()


def set_state_provider(provider: Callable[[], Mapping[str, Mapping[str, Any]]]) -> None:
    global _state_provider
    _state_provider = provider


def set_event_publisher(publisher: Callable[[dict[str, Any]], None]) -> None:
    global _event_publisher
    _event_publisher = publisher


mcp = FastMCP(
    name="gitdash-agent-events",
    instructions=(
        "Report explicit agent lifecycle and semantic status to gitdash. "
        "Use lifecycle events only for run_state. For status events always "
        "provide phase, attention, outcome, and summary, using null to clear "
        "a value. The call persists an append-only event and has side effects."
    ),
    streamable_http_path="/",
    stateless_http=True,
)


@mcp.tool()
def report_agent_status(
    event_id: str,
    task_id: str,
    worktree: str,
    occurred_at: str,
    kind: str,
    run_state: str,
    phase: str | None = Field(default_factory=lambda: _MISSING),  # type: ignore[assignment]
    attention: str | None = Field(default_factory=lambda: _MISSING),  # type: ignore[assignment]
    outcome: str | None = Field(default_factory=lambda: _MISSING),  # type: ignore[assignment]
    summary: str | None = Field(default_factory=lambda: _MISSING),  # type: ignore[assignment]
    agent_id: str | None = None,
    action: str | None = None,
) -> dict[str, Any]:
    """Persist one explicit agent event; this call changes gitdash state."""
    values: dict[str, Any] = dict(
        event_id=event_id,
        task_id=task_id,
        worktree=worktree,
        occurred_at=datetime.fromisoformat(occurred_at),
        kind=kind,
        run_state=run_state,
        agent_id=agent_id,
        action=action,
    )
    semantic = {"phase": phase, "attention": attention, "outcome": outcome, "summary": summary}
    if kind == "status":
        # Missing values remain absent so Pydantic can enforce the explicit
        # status contract; explicit null values remain present and clear data.
        values.update(semantic)
    else:
        # Lifecycle calls may omit semantic values, but cannot smuggle them in
        # (including explicit nulls), as lifecycle changes run_state only.
        values.update({key: value for key, value in semantic.items() if value is not _MISSING})
    request = agent_events.AgentEventRequest(**values)
    response = agent_events.append(request, _state_provider())
    _event_publisher({"event_id": event_id, "worktree": worktree, "snapshot": response.snapshot})
    return response.model_dump(mode="json")

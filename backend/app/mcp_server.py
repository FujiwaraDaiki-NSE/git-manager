"""The single MCP tool exposed by gitdash."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable, Mapping
from uuid import uuid4

from mcp.server.fastmcp import FastMCP

from app import agent_events

_state_provider: Callable[[], Mapping[str, Mapping[str, Any]]] = lambda: {}
_event_publisher: Callable[[dict[str, Any]], None] = lambda _event: None


def set_state_provider(provider: Callable[[], Mapping[str, Mapping[str, Any]]]) -> None:
    global _state_provider
    _state_provider = provider


def set_event_publisher(publisher: Callable[[dict[str, Any]], None]) -> None:
    global _event_publisher
    _event_publisher = publisher


mcp = FastMCP(
    name="gitdash-agent-events",
    streamable_http_path="/",
    stateless_http=True,
)


@mcp.tool(structured_output=False)
def report_agent_status(
    task_id: str,
    worktree: str,
    run_state: agent_events.RunState,
    phase: agent_events.Phase | None,
    attention: agent_events.Attention | None,
    outcome: agent_events.Outcome | None,
    summary: str | None,
    agent_id: str | None = None,
) -> str:
    """Save current status. Reuse task_id; worktree is a known absolute root. Null clears a field. Keep summary brief. Lifecycle uses hooks."""
    request = agent_events.AgentEventRequest(
        event_id=str(uuid4()),
        occurred_at=datetime.now(timezone.utc),
        kind="status",
        task_id=task_id,
        worktree=worktree,
        run_state=run_state,
        phase=phase,
        attention=attention,
        outcome=outcome,
        summary=summary,
        agent_id=agent_id,
    )
    response = agent_events.append(request, _state_provider())
    _event_publisher({"event_id": request.event_id, "worktree": worktree, "snapshot": response.snapshot})
    return "ok"

"""The single MCP tool exposed by gitdash."""
from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Annotated, Any, Callable, Mapping
from uuid import uuid4

from mcp.server.fastmcp import FastMCP
from pydantic import Field

from app import agent_events, gitinfo, paths

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


def _current_branch(worktree: str, state: Mapping[str, Mapping[str, Any]]) -> tuple[str, str]:
    """Validate the exact known root and read its branch from Git now."""
    associated = agent_events.known_worktree(worktree, state)
    if associated is None:
        raise ValueError("unknown worktree")
    container_worktree = paths.to_container(worktree)
    root = gitinfo._run(container_worktree, ["rev-parse", "--show-toplevel"])
    if root is None or os.path.realpath(root.strip()) != os.path.realpath(container_worktree):
        raise ValueError("worktree is not a Git root")
    branch = gitinfo._run(container_worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"])
    if branch is None or not branch.strip():
        raise ValueError("detached HEAD")
    project_id = associated.get("common_dir")
    if not isinstance(project_id, str) or not project_id:
        raise ValueError("worktree has no known repository root")
    return project_id, branch.strip()


@mcp.tool(structured_output=False)
def report_agent_status(
    worktree: Annotated[str, Field(description="Gitルートの絶対パス")],
    status: Annotated[agent_events.Status, Field(description="現在の作業状態")],
    summary: Annotated[str | None, Field(description="短い説明。不要ならnull")],
) -> str:
    """ブランチの作業状況が変わったときに報告する。worktreeには作業中のGitルートの絶対パス、statusには現在の状態、summaryには短い説明（不要ならnull）を指定する。"""
    state = _state_provider()
    project_id, branch = _current_branch(worktree, state)
    fields = agent_events.status_fields(status)
    task_id = agent_events.task_key(project_id, branch)
    append_state = dict(state)
    append_state[worktree] = {**state[worktree], "branch": branch}
    request = agent_events.AgentEventRequest(
        event_id=str(uuid4()),
        occurred_at=datetime.now(timezone.utc),
        kind="status",
        task_id=task_id,
        worktree=worktree,
        run_state=fields["run_state"],
        phase=fields["phase"],
        attention=fields["attention"],
        outcome=fields["outcome"],
        summary=summary,
    )
    response = agent_events.append(request, append_state)
    if response.snapshot is None:
        raise RuntimeError("agent event snapshot unavailable")
    snapshot = response.snapshot
    _event_publisher(
        {
            "event_id": request.event_id,
            "worktree": worktree,
            "kind": snapshot.get("kind"),
            "branch": snapshot.get("branch"),
            "status": snapshot.get("status"),
            "snapshot": snapshot,
        }
    )
    return "ok"

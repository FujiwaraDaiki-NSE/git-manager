"""Acceptance coverage for the Phase 2 agent integration contract."""
from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import subprocess
import sys
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import httpx
import pytest
from fastapi import HTTPException

from app import agent_events, main, mcp_server, project


def ts(day: int = 1) -> datetime:
    return datetime(2026, 1, day, tzinfo=timezone.utc)


@pytest.fixture
def event_context(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[str, dict[str, dict[str, object]]]:
    data = tmp_path / "data"
    monkeypatch.setenv("GITDASH_DATA_DIR", str(data))
    monkeypatch.setenv("GITDASH_AGENT_TOKEN", "test-token")
    worktree = tmp_path / "repo"
    worktree.mkdir()
    subprocess.run(["git", "-C", str(worktree), "init", "-q", "-b", "main"], check=True)
    state = {
        str(worktree): {
            "path": str(worktree),
            "common_dir": str(worktree),
            "is_worktree": False,
            "branch": "main",
        }
    }
    main.STATE.clear()
    main.STATE.update(state)
    agent_events.initialize()
    return str(worktree), state


def status_payload(worktree: str, event_id: str = "e1", **changes: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "event_id": event_id,
        "task_id": "task-1",
        "worktree": worktree,
        "occurred_at": ts().isoformat(),
        "kind": "status",
        "run_state": "active",
        "phase": "implementing",
        "attention": None,
        "outcome": None,
        "summary": "working",
    }
    payload.update(changes)
    return payload


def post(path: str, body: dict[str, object], headers: dict[str, str] | None = None) -> httpx.Response:
    async def run() -> httpx.Response:
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.post(path, json=body, headers=headers or {})

    return asyncio.run(run())


def test_auth_absent_wrong_and_correct(event_context: tuple[str, dict[str, dict[str, object]]]) -> None:
    worktree, _ = event_context
    body = status_payload(worktree)
    assert post("/api/agent-events", body).status_code == 401
    assert post("/api/agent-events", body, {"Authorization": "Bearer wrong"}).status_code == 401
    assert post("/api/agent-events", body, {"Authorization": "Bearer test-token"}).status_code == 200


def test_missing_configured_token_reports_integration_unavailable(event_context: tuple[str, dict[str, dict[str, object]]], monkeypatch: pytest.MonkeyPatch) -> None:
    worktree, _ = event_context
    monkeypatch.delenv("GITDASH_AGENT_TOKEN")
    assert post("/api/agent-events", status_payload(worktree)).status_code == 503


def test_missing_invalid_timezone_and_unknown_path_validation(event_context: tuple[str, dict[str, dict[str, object]]]) -> None:
    worktree, _ = event_context
    missing = status_payload(worktree)
    del missing["task_id"]
    assert post("/api/agent-events", missing, {"Authorization": "Bearer test-token"}).status_code == 422
    invalid_kind = status_payload(worktree, kind="bogus")
    assert post("/api/agent-events", invalid_kind, {"Authorization": "Bearer test-token"}).status_code == 422
    naive = status_payload(worktree, occurred_at="2026-01-01T00:00:00")
    assert post("/api/agent-events", naive, {"Authorization": "Bearer test-token"}).status_code == 422
    unknown = status_payload("/tmp/not-a-known-worktree")
    assert post("/api/agent-events", unknown, {"Authorization": "Bearer test-token"}).status_code == 422


def test_status_requires_explicit_semantic_fields_and_lifecycle_rejects_them(event_context: tuple[str, dict[str, dict[str, object]]]) -> None:
    worktree, state = event_context
    missing = status_payload(worktree)
    del missing["summary"]
    with pytest.raises(ValueError):
        agent_events.AgentEventRequest.model_validate(missing)
    lifecycle = {
        "event_id": "life",
        "task_id": "task-1",
        "worktree": worktree,
        "occurred_at": ts().isoformat(),
        "kind": "lifecycle",
        "run_state": "active",
        "action": "session_start",
        "phase": None,
    }
    with pytest.raises(ValueError):
        agent_events.AgentEventRequest.model_validate(lifecycle)
    bad_lifecycle = {key: value for key, value in lifecycle.items() if key != "phase"}
    bad_lifecycle["run_state"] = "ended"
    with pytest.raises(ValueError):
        agent_events.append(agent_events.AgentEventRequest.model_validate(bad_lifecycle), state)


def test_idempotency_out_of_order_null_clearing_and_lifecycle_projection(event_context: tuple[str, dict[str, dict[str, object]]]) -> None:
    worktree, state = event_context
    first = agent_events.AgentEventRequest.model_validate(status_payload(worktree, "first", occurred_at=ts(2).isoformat(), attention="blocked"))
    second = agent_events.AgentEventRequest.model_validate(status_payload(worktree, "second", occurred_at=ts(3).isoformat(), phase=None, attention=None, summary=None))
    old = agent_events.AgentEventRequest.model_validate(status_payload(worktree, "old", occurred_at=ts(1).isoformat(), phase="investigating", summary="old"))
    r1 = agent_events.append(first, state)
    duplicate = agent_events.append(first, state)
    assert r1.idempotent is False and duplicate.idempotent is True and duplicate.sequence == r1.sequence
    agent_events.append(second, state)
    agent_events.append(old, state)
    projection = agent_events.projection(worktree)
    assert projection is not None
    assert projection["phase"] is None and projection["attention"] is None and projection["summary"] is None
    lifecycle = agent_events.AgentEventRequest.model_validate({
        "event_id": "end", "task_id": "task-1", "worktree": worktree,
        "occurred_at": ts(4).isoformat(), "kind": "lifecycle", "run_state": "ended", "action": "session_end",
    })
    agent_events.append(lifecycle, state)
    projection = agent_events.projection(worktree)
    assert projection is not None and projection["run_state"] == "ended"
    assert projection["phase"] is None and projection["summary"] is None


def test_same_event_id_with_different_payload_is_conflict(event_context: tuple[str, dict[str, dict[str, object]]]) -> None:
    worktree, state = event_context
    original = agent_events.AgentEventRequest.model_validate(status_payload(worktree, "same"))
    changed = agent_events.AgentEventRequest.model_validate(status_payload(worktree, "same", summary="changed"))
    agent_events.append(original, state)
    with pytest.raises(agent_events.DuplicateEventConflict):
        agent_events.append(changed, state)
    assert len(agent_events.events(worktree=worktree)) == 1
    assert post(
        "/api/agent-events",
        changed.model_dump(mode="json"),
        {"Authorization": "Bearer test-token"},
    ).status_code == 409


def test_multiple_agents_have_mutually_exclusive_priority_counts(event_context: tuple[str, dict[str, dict[str, object]]]) -> None:
    worktree, state = event_context
    events = [
        ("wait", "waiting_for_user", "active"),
        ("block", "blocked", "active"),
        ("review", "review_required", "active"),
        ("merge", "merge_ready", "active"),
        ("active", None, "active"),
        ("done", None, "ended"),
    ]
    paths = [worktree]
    for index in range(1, len(events)):
        path = str(Path(worktree).parent / f"worktree-{index}")
        state[path] = {"path": path, "common_dir": worktree, "is_worktree": True, "branch": f"feature-{index}"}
        paths.append(path)
    for index, (event_id, attention, run_state) in enumerate(events):
        path = paths[index]
        body = status_payload(path, event_id, task_id=event_id, attention=attention, run_state=run_state, outcome="completed" if event_id == "done" else None)
        agent_events.append(agent_events.AgentEventRequest.model_validate(body), state)
    summary = project.summary_rows(state)[0]
    counts = summary["agent_priority_counts"]
    assert counts == {"waiting_for_user": 1, "blocked": 1, "review_required": 1, "merge_ready": 1, "active": 1, "completed": 1}


def test_same_worktree_preserves_distinct_tasks_and_agents(event_context: tuple[str, dict[str, dict[str, object]]]) -> None:
    worktree, state = event_context
    for task_id, agent_id, summary in (("task-a", None, "root"), ("task-b", "subagent-b", "subagent")):
        body = status_payload(worktree, task_id, task_id=task_id, agent_id=agent_id, summary=summary)
        agent_events.append(agent_events.AgentEventRequest.model_validate(body), state)
    snapshots = agent_events.snapshots(project_id=worktree, state=state)
    assert {(item["task_id"], item["agent_id"]) for item in snapshots.values()} == {
        ("task-a", None), ("task-b", "subagent-b")
    }


def test_close_reopen_persistence_and_as_of(event_context: tuple[str, dict[str, dict[str, object]]]) -> None:
    worktree, state = event_context
    for event_id, day in (("a", 1), ("b", 2)):
        body = status_payload(worktree, event_id, occurred_at=ts(day).isoformat(), summary=event_id)
        agent_events.append(agent_events.AgentEventRequest.model_validate(body), state)
    db = agent_events.db_path()
    assert db.exists()
    as_of = agent_events.projection(worktree, as_of=ts(1))
    assert as_of is not None and as_of["summary"] == "a"
    # A fresh connection after the first connection has been closed sees all rows.
    assert [row["event_id"] for row in agent_events.events(worktree=worktree)] == ["a", "b"]
    assert [row["event_id"] for row in agent_events.events(worktree=worktree, as_of=ts(1))] == ["a"]


def test_project_detail_joins_exact_worktree_and_summary(event_context: tuple[str, dict[str, dict[str, object]]]) -> None:
    worktree, state = event_context
    body = status_payload(worktree, attention="waiting_for_user", summary="need input")
    agent_events.append(agent_events.AgentEventRequest.model_validate(body), state)
    result = project.build(worktree, worktree, state)
    assert result is not None
    lane = next(item for item in result["lanes"] if item["path"] == worktree)
    assert lane["agent"]["attention"] == "waiting_for_user"
    assert any(item["event_id"] == "e1" for item in result["agent_events"])
    assert result["agent_counts"]["waiting_for_user"] == 1
    assert project.summary_rows(state)[0]["latest_summary"] == "need input"


def test_sse_publish_observes_committed_row(event_context: tuple[str, dict[str, dict[str, object]]], monkeypatch: pytest.MonkeyPatch) -> None:
    worktree, _ = event_context
    seen: list[bool] = []

    def publish(_event: str, data: object) -> None:
        assert isinstance(data, dict)
        seen.append(any(row["event_id"] == "e1" for row in agent_events.events()))

    monkeypatch.setattr(main.bus, "publish", publish)
    assert post("/api/agent-events", status_payload(worktree), {"Authorization": "Bearer test-token"}).status_code == 200
    assert seen == [True]


def test_sse_is_not_published_when_commit_fails(event_context: tuple[str, dict[str, dict[str, object]]], monkeypatch: pytest.MonkeyPatch) -> None:
    worktree, _ = event_context
    published: list[object] = []
    monkeypatch.setattr(main.agent_events, "append", lambda *_args: (_ for _ in ()).throw(sqlite3.OperationalError("disk full")))
    monkeypatch.setattr(main.bus, "publish", lambda *_args: published.append(True))
    assert post("/api/agent-events", status_payload(worktree), {"Authorization": "Bearer test-token"}).status_code == 503
    assert published == []


def test_fastmcp_only_lists_and_calls_report_agent_status(event_context: tuple[str, dict[str, dict[str, object]]]) -> None:
    worktree, state = event_context
    mcp_server.set_state_provider(lambda: state)
    tools = asyncio.run(mcp_server.mcp.list_tools())
    assert [tool.name for tool in tools] == ["report_agent_status"]
    required = set(tools[0].inputSchema.get("required", []))
    assert {"phase", "attention", "outcome", "summary"} <= required
    result = asyncio.run(mcp_server.mcp.call_tool("report_agent_status", status_payload(worktree, "mcp")))
    assert isinstance(result, tuple) and isinstance(result[1], dict)
    assert any(row["event_id"] == "mcp" for row in agent_events.events())


class _CaptureHandler(BaseHTTPRequestHandler):
    payloads: list[dict[str, object]] = []

    def do_POST(self) -> None:  # noqa: N802
        size = int(self.headers["Content-Length"])
        self.payloads.append(json.loads(self.rfile.read(size)))
        self.send_response(200)
        self.end_headers()

    def log_message(self, *_args: object) -> None:
        return


def run_hook(script: Path, cwd: Path, hook: str, **env: str) -> subprocess.CompletedProcess[str]:
    merged = os.environ.copy()
    merged.update(env)
    hook_input: dict[str, object] = {
        "session_id": "task-hook",
        "cwd": str(cwd),
        "hook_event_name": hook,
        "model": "test-model",
    }
    if hook == "SubagentStart":
        hook_input["agent_id"] = "agent-hook"
    return subprocess.run(
        [sys.executable, str(script)],
        cwd=cwd,
        env=merged,
        input=json.dumps(hook_input),
        capture_output=True,
        text=True,
        check=False,
    )


def test_hook_mapping_failure_modes_and_real_git_worktree(tmp_path: Path) -> None:
    script = Path(__file__).parents[2] / ".codex/hooks/report_agent_event.py"
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "-C", str(repo), "init", "-q", "-b", "main"], check=True)
    _CaptureHandler.payloads = []
    server = HTTPServer(("127.0.0.1", 0), _CaptureHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    endpoint = f"http://127.0.0.1:{server.server_port}/api/agent-events"
    common = {"GITDASH_AGENT_ENDPOINT": endpoint, "GITDASH_AGENT_TOKEN": "token"}
    try:
        for hook, run_state, action in (
            ("SessionStart", "active", "session_start"),
            ("SubagentStart", "active", "subagent_start"),
            ("Interrupt", "interrupted", "interrupt"),
            ("SubagentStop", "idle", "subagent_stop"),
            ("SessionEnd", "ended", "session_end"),
        ):
            result = run_hook(script, repo, hook, **common)
            assert result.returncode == 0
            assert _CaptureHandler.payloads[-1]["run_state"] == run_state
            assert _CaptureHandler.payloads[-1]["action"] == action
            assert _CaptureHandler.payloads[-1]["task_id"] == "task-hook"
        assert _CaptureHandler.payloads[1]["agent_id"] == "agent-hook"
        assert all(payload["kind"] == "lifecycle" for payload in _CaptureHandler.payloads)
        assert run_hook(script, repo, "SessionStart", GITDASH_AGENT_TOKEN="token").returncode == 0
        assert run_hook(script, tmp_path, "SessionStart", **common).returncode == 0
        assert run_hook(script, repo, "SessionStart", GITDASH_AGENT_ENDPOINT=endpoint).returncode == 0
        # Endpoint failure is intentionally non-fatal to the hook process.
        assert run_hook(script, repo, "SessionStart", GITDASH_AGENT_ENDPOINT="http://127.0.0.1:1", GITDASH_AGENT_TOKEN="token").returncode == 0
    finally:
        server.shutdown()
        thread.join(timeout=2)


def test_project_local_mcp_config_and_hooks_shape() -> None:
    root = Path(__file__).parents[2]
    hooks = json.loads((root / ".codex/hooks.json").read_text())
    assert set(hooks["hooks"]) == {"SessionStart", "SubagentStart", "Interrupt", "SubagentStop", "SessionEnd"}
    for groups in hooks["hooks"].values():
        assert len(groups) == 1
        assert set(groups[0]) == {"hooks"}
        assert len(groups[0]["hooks"]) == 1
        handler = groups[0]["hooks"][0]
        assert set(handler) == {"type", "command", "timeout"}
        assert handler["type"] == "command" and handler["timeout"] == 3
        assert "git rev-parse --show-toplevel" in handler["command"]
    import tomllib

    config = tomllib.loads((root / ".codex/config.toml").read_text())
    server = config["mcp_servers"]["gitdash-agent-events"]
    assert set(server) == {"url", "bearer_token_env_var"}
    assert server["bearer_token_env_var"] == "GITDASH_AGENT_TOKEN"
    assert server["url"].endswith("/mcp")

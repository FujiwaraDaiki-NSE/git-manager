import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_STATE_LABELS,
  agentSnapshotAt,
  agentStateLabel,
  agentTaskState,
  countsFromTasks,
  deferProjectOrder,
  highestAgentState,
  isExplicitAgentStatus,
  mergeAgentSnapshot,
  sortProjects,
  topAgentTasks,
} from "../app/agent-overview.mjs";

const task = (task_id, run_state, occurred_at, extra = {}) => ({
  task_id,
  agent_id: `agent-${task_id}`,
  project_id: "repo",
  worktree: `/work/${task_id}`,
  branch: task_id,
  kind: "status",
  status: extra.status || ({ active: "implementing", blocked: "blocked", waiting_for_user: "waiting_for_user", review_required: "review_required", completed: "completed", stopped: "stopped" }[run_state] || run_state),
  run_state,
  phase: null,
  attention: null,
  outcome: null,
  summary: null,
  occurred_at,
  ...extra,
});

test("agent priority, top three, and mutually exclusive counts use explicit states", () => {
  const tasks = [
    task("active", "active", "2026-09-01T01:00:00Z"),
    task("blocked", "active", "2026-09-01T02:00:00Z", { status: "blocked", attention: "blocked" }),
    task("waiting", "active", "2026-09-01T00:00:00Z", { status: "waiting_for_user", attention: "waiting_for_user" }),
    task("review", "active", "2026-09-01T03:00:00Z", { status: "review_required", attention: "review_required" }),
  ];
  assert.equal(agentTaskState(tasks[1]), "blocked");
  assert.equal(agentTaskState(task("active-done", "active", "2026-09-01T04:00:00Z", { outcome: "completed" })), "implementing");
  assert.equal(highestAgentState(tasks), "waiting_for_user");
  assert.deepEqual(topAgentTasks(tasks, 3).map((item) => item.task_id), ["waiting", "blocked", "review"]);
  assert.deepEqual(countsFromTasks(tasks), { waiting_for_user: 1, blocked: 1, review_required: 1, merge_ready: 0, active: 1, completed: 0, total: 4 });
  assert.equal(highestAgentState([]), null);
  assert.deepEqual(countsFromTasks(null), { waiting_for_user: 0, blocked: 0, review_required: 0, merge_ready: 0, active: 0, completed: 0, total: 0 });
});

test("project sorting uses agent priority, then absolute latest time", () => {
  const base = { git: { conflict: 0, dirty: 0, behind: 0 }, latest_observed_at: 0, agent_tasks: [] };
  const projects = [
    { ...base, id: "active", name: "active", agent_state: "active", latest_agent_event: { occurred_at: "2026-09-01T03:00:00Z" } },
    { ...base, id: "waiting", name: "waiting", agent_state: "waiting_for_user", latest_agent_event: { occurred_at: "2026-09-01T00:00:00Z" } },
    { ...base, id: "blocked", name: "blocked", agent_state: "blocked", latest_agent_event: { occurred_at: "2026-09-01T02:00:00Z" } },
  ];
  assert.deepEqual(sortProjects(projects).map((item) => item.id), ["waiting", "blocked", "active"]);
});

test("as-of snapshots choose one latest event per task without showing future state", () => {
  const events = [
    { ...task("one", "active", "2026-09-01T01:00:00Z"), event_id: "1", observed_at: 1 },
    { ...task("one", "completed", "2026-09-01T03:00:00Z"), event_id: "2", observed_at: 2 },
    { ...task("two", "blocked", "2026-09-01T02:00:00Z"), event_id: "3", observed_at: 3 },
  ];
  assert.deepEqual(agentSnapshotAt(events, Date.parse("2026-09-01T02:30:00Z")).map((item) => item.status), ["blocked", "implementing"]);
});

test("as-of lifecycle history does not overwrite the explicit branch status", () => {
  const events = [
    { ...task("one", "active", "2026-09-01T01:00:00Z", { status: "testing", phase: "testing", attention: "blocked", summary: "テスト失敗" }), event_id: "status", sequence: 1 },
    { ...task("one", "stopped", "2026-09-01T02:00:00Z", { kind: "lifecycle", status: null, phase: null, attention: null, summary: null }), event_id: "lifecycle", sequence: 2 },
  ];
  const [snapshot] = agentSnapshotAt(events, Date.parse("2026-09-01T02:30:00Z"));
  assert.equal(snapshot.run_state, "active");
  assert.equal(snapshot.status, "testing");
  assert.equal(snapshot.phase, "testing");
  assert.equal(snapshot.attention, "blocked");
  assert.equal(snapshot.summary, "テスト失敗");
});

test("incremental agent snapshot updates one project task without replacing Git facts", () => {
  const project = {
    id: "repo",
    git: { conflict: 0, dirty: 0, behind: 0 },
    agent_tasks: [task("one", "active", "2026-09-01T01:00:00Z")],
    agent_priority_counts: { waiting_for_user: 0, blocked: 0, review_required: 0, merge_ready: 0, active: 1, completed: 0 },
    agent_state: "active",
    latest_agent_event: null,
    latest_event: { date: "2026-09-01T01:00:00Z" },
  };
  const event = { ...task("one", "active", "2026-09-01T02:00:00Z", { status: "waiting_for_user", attention: "waiting_for_user", summary: "回答待ち" }), event_id: "next", observed_at: 2 };
  const next = mergeAgentSnapshot(project, event);
  assert.equal(next.agent_tasks.length, 1);
  assert.equal(next.agent_tasks[0].attention, "waiting_for_user");
  assert.equal(next.agent_priority_counts.waiting_for_user, 1);
  assert.equal(next.agent_state, "waiting_for_user");
  assert.equal(next.latest_event.date, "2026-09-01T01:00:00Z");
});

test("deferred ordering retains focused cards and exposes changed order", () => {
  assert.deepEqual(deferProjectOrder(["a", "b", "c"], ["b", "a", "c"], true), { order: ["a", "b", "c"], deferred: true });
  assert.deepEqual(deferProjectOrder(["a", "b"], ["b", "a"], false), { order: ["b", "a"], deferred: false });
});

test("agent events cannot cross projects through a common branch name", async () => {
  const { projectMatchesAgentEvent, laneMatchesAgentEvent } = await import("../app/agent-overview.mjs");
  const project = { id: "project-a", main_path: "/a", lanes: [{ path: "/a/work", branch: "main" }, { path: null, branch: null }] };
  assert.equal(projectMatchesAgentEvent(project, { project_id: "project-b", worktree: "/b", branch: "main" }), false);
  assert.equal(projectMatchesAgentEvent(project, { project_id: null, worktree: null, branch: null }), false);
  assert.equal(projectMatchesAgentEvent(project, { project_id: "project-a", worktree: "/a/work", branch: "feature" }), true);
  assert.equal(projectMatchesAgentEvent(project, { project_id: "project-b", worktree: "/a", branch: "main" }), false);
  assert.equal(projectMatchesAgentEvent(project, { project_id: "project-a", worktree: "/a", branch: "main" }), true);
  assert.equal(laneMatchesAgentEvent({ path: null, branch: null }, { project_id: "project-a", worktree: null, branch: null }), false);
});

test("explicit branch status is precise, lifecycle rows stay activity-only, and counts keep stopped in total", () => {
  const first = {
    ...task("feature-a", "active", "2026-09-01T01:00:00Z", {
      event_id: "status-1",
      project_id: "repo",
      worktree: "/work/old",
      branch: "feature",
      kind: "status",
      status: "implementing",
      summary: "実装中",
      sequence: 1,
    }),
  };
  const second = {
    ...first,
    event_id: "status-2",
    worktree: "/work/new",
    status: "testing",
    summary: "テスト中",
    occurred_at: "2026-09-01T02:00:00Z",
    sequence: 2,
  };
  const lifecycle = {
    ...second,
    event_id: "lifecycle-3",
    kind: "lifecycle",
    status: null,
    run_state: "ended",
    summary: null,
    occurred_at: "2026-09-01T03:00:00Z",
    sequence: 3,
  };
  assert.equal(isExplicitAgentStatus(first), true);
  assert.equal(isExplicitAgentStatus(lifecycle), false);
  assert.equal(agentStateLabel("merge_ready"), "マージ可能");
  assert.equal(AGENT_STATE_LABELS.stopped, "中断");
  assert.deepEqual(
    agentSnapshotAt([first, second, lifecycle], Date.parse("2026-09-01T04:00:00Z")),
    [second],
  );
  assert.deepEqual(countsFromTasks([
    { ...second, status: "implementing" },
    { ...second, branch: "done", status: "completed" },
    { ...second, branch: "stopped", status: "stopped" },
  ]), {
    waiting_for_user: 0,
    blocked: 0,
    review_required: 0,
    merge_ready: 0,
    active: 1,
    completed: 1,
    total: 3,
  });
});

test("incremental branch reports replace across worktrees and reject stale lifecycle/status SSE", () => {
  const current = {
    id: "repo",
    git: { conflict: 0, dirty: 0, behind: 0 },
    agent_tasks: [{
      project_id: "repo", task_id: null, agent_id: null, worktree: "/work/old", branch: "feature",
      kind: "status", status: "implementing", run_state: "active", phase: null, attention: null,
      outcome: null, summary: "旧", occurred_at: "2026-09-01T01:00:00Z", event_id: "old", sequence: 1,
    }],
    agent_priority_counts: { waiting_for_user: 0, blocked: 0, review_required: 0, merge_ready: 0, active: 1, completed: 0 },
    agent_state: "implementing",
    latest_agent_event: null,
    latest_event: null,
  };
  const newer = {
    project_id: "repo", task_id: null, agent_id: null, worktree: "/work/new", branch: "feature",
    kind: "status", status: "testing", run_state: "active", phase: null, attention: null,
    outcome: null, summary: "新", occurred_at: "2026-09-01T02:00:00Z", event_id: "new", sequence: 2,
  };
  const older = { ...newer, status: "blocked", summary: "遅延到着", occurred_at: "2026-09-01T00:30:00Z", event_id: "late", sequence: 3 };
  const lifecycle = { ...newer, kind: "lifecycle", status: null, run_state: "ended", summary: null, event_id: "hook", sequence: 4 };
  const afterNew = mergeAgentSnapshot(current, newer);
  assert.equal(afterNew.agent_tasks.length, 1);
  assert.equal(afterNew.agent_tasks[0].worktree, "/work/new");
  assert.equal(afterNew.agent_tasks[0].status, "testing");
  assert.equal(mergeAgentSnapshot(afterNew, older), afterNew);
  assert.equal(mergeAgentSnapshot(afterNew, lifecycle), afterNew);
  assert.equal(afterNew.agent_state, "testing");
});

test("malformed reports without canonical project and branch identity never change branch state", async () => {
  const { projectMatchesAgentEvent } = await import("../app/agent-overview.mjs");
  const project = {
    id: "repo",
    main_path: "/repo",
    lanes: [{ path: "/repo/work", branch: "feature" }],
    agent_tasks: [],
    agent_priority_counts: { waiting_for_user: 0, blocked: 0, review_required: 0, merge_ready: 0, active: 0, completed: 0 },
    agent_state: null,
    latest_agent_event: null,
  };
  const malformed = {
    kind: "status", status: "testing", worktree: "/repo/work", branch: "feature",
    occurred_at: "2026-09-01T01:00:00Z", event_id: "malformed", sequence: 1,
  };
  assert.equal(projectMatchesAgentEvent(project, malformed), false);
  assert.equal(mergeAgentSnapshot(project, malformed), project);
  assert.deepEqual(agentSnapshotAt([malformed], Date.parse("2026-09-01T02:00:00Z")), []);
});

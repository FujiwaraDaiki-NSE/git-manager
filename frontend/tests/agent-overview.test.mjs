import assert from "node:assert/strict";
import test from "node:test";

import {
  agentSnapshotAt,
  countsFromTasks,
  deferProjectOrder,
  highestAgentState,
  sortProjects,
  topAgentTasks,
} from "../app/agent-overview.mjs";

const task = (task_id, run_state, occurred_at, extra = {}) => ({
  task_id,
  agent_id: `agent-${task_id}`,
  worktree: `/work/${task_id}`,
  branch: task_id,
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
    task("blocked", "blocked", "2026-09-01T02:00:00Z"),
    task("waiting", "waiting_for_user", "2026-09-01T00:00:00Z"),
    task("review", "review_required", "2026-09-01T03:00:00Z"),
  ];
  assert.equal(highestAgentState(tasks), "waiting_for_user");
  assert.deepEqual(topAgentTasks(tasks, 3).map((item) => item.task_id), ["waiting", "blocked", "review"]);
  assert.deepEqual(countsFromTasks(tasks), { waiting_for_user: 1, blocked: 1, review_required: 1, merge_ready: 0, active: 1, completed: 0, total: 4 });
  assert.equal(highestAgentState([]), null);
  assert.deepEqual(countsFromTasks(null), { waiting_for_user: 0, blocked: 0, review_required: 0, merge_ready: 0, active: 0, completed: 0, total: 0 });
});

test("project sorting uses agent priority, then absolute latest time", () => {
  const base = { git: { conflict: 0, dirty: 0, behind: 0 }, latest_observed_at: 0, agent_tasks: [] };
  const projects = [
    { ...base, id: "active", name: "active", priority_state: "active", latest_agent_event: { occurred_at: "2026-09-01T03:00:00Z" } },
    { ...base, id: "waiting", name: "waiting", priority_state: "waiting_for_user", latest_agent_event: { occurred_at: "2026-09-01T00:00:00Z" } },
    { ...base, id: "blocked", name: "blocked", priority_state: "blocked", latest_agent_event: { occurred_at: "2026-09-01T02:00:00Z" } },
  ];
  assert.deepEqual(sortProjects(projects).map((item) => item.id), ["waiting", "blocked", "active"]);
});

test("as-of snapshots choose one latest event per task without showing future state", () => {
  const events = [
    { ...task("one", "active", "2026-09-01T01:00:00Z"), event_id: "1", observed_at: 1 },
    { ...task("one", "completed", "2026-09-01T03:00:00Z"), event_id: "2", observed_at: 2 },
    { ...task("two", "blocked", "2026-09-01T02:00:00Z"), event_id: "3", observed_at: 3 },
  ];
  assert.deepEqual(agentSnapshotAt(events, Date.parse("2026-09-01T02:30:00Z")).map((item) => item.run_state), ["blocked", "active"]);
});

test("deferred ordering retains focused cards and exposes changed order", () => {
  assert.deepEqual(deferProjectOrder(["a", "b", "c"], ["b", "a", "c"], true), { order: ["a", "b", "c"], deferred: true });
  assert.deepEqual(deferProjectOrder(["a", "b"], ["b", "a"], false), { order: ["b", "a"], deferred: false });
});

import assert from "node:assert/strict";
import test from "node:test";

import { projectPriority, projectLatestTime } from "../app/agent-overview.mjs";

const task = {
  task_id: "task-1",
  agent_id: "agent-1",
  worktree: "/workspace/feature",
  branch: "feature",
  run_state: "waiting_for_user",
  phase: "testing",
  attention: "質問への回答が必要",
  outcome: null,
  summary: "テスト結果を確認してください",
  occurred_at: "2026-09-05T07:00:00Z",
};

const counts = {
  running: 0,
  waiting_for_user: 1,
  problem: 0,
  reviewing: 0,
  integratable: 0,
};

const priorityCounts = {
  waiting_for_user: 1,
  blocked: 0,
  review_required: 0,
  merge_ready: 0,
  active: 0,
  completed: 0,
};

const summaryPayload = {
  id: "repo",
  name: "repo",
  main_path: "/workspace/repo",
  remote: null,
  lane_count: 1,
  worktree_count: 1,
  git: { dirty: 0, conflict: 0, ahead: 0, behind: 0, merged: 0, prunable: 0, locked: 0 },
  latest_event: null,
  latest_observed_at: 0,
  priority: 0,
  next_lane: "feature",
  largest_difference_lane: null,
  agent_counts: counts,
  agent_priority_counts: priorityCounts,
  agent_state: "waiting_for_user",
  agent_tasks: [task],
  latest_agent_event: { ...task, event_id: "event-1", observed_at: 1_000 },
};

const detailPayload = {
  ...summaryPayload,
  description: null,
  default_branch: "main",
  default_hash: null,
  fetched_at: null,
  observed_at: 1_000,
  range: "current",
  graph: null,
  lanes: [{ id: "feature", name: "feature", branch: "feature", path: "/workspace/feature", agents: [task], current_agent: task }],
  events: [],
  latest_event: null,
  branch_counts: { local: 1, remote: 0 },
  worktrees: [],
  maintenance: { merged: 0, prunable: 0, locked: 0 },
  languages: null,
  directories: null,
  test_commands: null,
  agent_latest_event: { ...task, event_id: "event-1", observed_at: 1_000 },
  agent_events: [{ ...task, event_id: "event-1", observed_at: 1_000 }],
  ci: null,
  reviews: null,
  merge_target: null,
};

test("frontend contract follows backend legacy and priority agent fields", () => {
  assert.equal(summaryPayload.agent_counts.waiting_for_user, 1);
  assert.equal(summaryPayload.agent_priority_counts.waiting_for_user, 1);
  assert.equal(projectPriority(summaryPayload), 0);
  assert.equal(summaryPayload.agent_state, "waiting_for_user");
  assert.equal(summaryPayload.latest_agent_event.summary, "テスト結果を確認してください");
  assert.equal(detailPayload.agent_latest_event.event_id, "event-1");
  assert.equal(detailPayload.lanes[0].current_agent.task_id, "task-1");
  assert.equal(projectLatestTime(summaryPayload), Date.parse(task.occurred_at));
  for (const key of ["waiting_for_user", "blocked", "review_required", "merge_ready", "active", "completed"]) {
    assert.notEqual(summaryPayload.agent_priority_counts[key], undefined);
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyBufferedAgentEvents,
  currentAgentTasks,
  hasUnknownCurrentTasks,
  mergeAgentEvents,
} from "../app/agent-timeline-tools.mjs";

const event = (event_id, occurred_at, extra = {}) => ({
  event_id,
  sequence: extra.sequence ?? 1,
  project_id: extra.project_id ?? "/workspace/project",
  worktree: extra.worktree ?? "/workspace/project",
  branch: extra.branch ?? "feature",
  kind: extra.kind ?? "status",
  status: extra.status ?? "implementing",
  run_state: extra.run_state ?? "active",
  phase: null,
  attention: null,
  outcome: null,
  summary: extra.summary ?? null,
  occurred_at,
  observed_at: extra.observed_at ?? 1,
});

test("history replay and SSE delivery merge by event id and stay newest first", () => {
  const replay = event("one", "2026-10-19T01:00:00Z", { sequence: 1 });
  const latest = event("two", "2026-10-19T03:00:00Z", { sequence: 2 });
  const duplicate = { ...latest, summary: "同じイベントの再配信" };
  const merged = mergeAgentEvents([latest, replay], [duplicate, replay]);
  assert.deepEqual(merged.map((item) => item.event_id), ["two", "one"]);
  assert.equal(merged[0].summary, "同じイベントの再配信");
});

test("current rows come from explicit project snapshots, never lifecycle history", () => {
  const project = {
    id: "/workspace/project",
    name: "project",
    main_path: "/workspace/project",
    agent_tasks: [
      event("status", "2026-10-19T02:00:00Z", { status: "testing", summary: "テスト中" }),
      event("done", "2026-10-19T03:00:00Z", { branch: "done", status: "completed" }),
      event("lifecycle", "2026-10-19T04:00:00Z", { kind: "lifecycle", status: null, run_state: "ended" }),
    ],
  };
  const current = currentAgentTasks([project]);
  assert.equal(current.length, 2);
  assert.deepEqual(current.map(({ task }) => task.status), ["testing", "completed"]);
  assert.equal(current.some(({ task }) => task.kind === "lifecycle"), false);
});

test("replay reconciles a stale project snapshot with a missed attention event", () => {
  const old = event("old", "2026-10-19T01:00:00Z");
  const waiting = event("waiting", "2026-10-19T02:00:00Z", { status: "waiting_for_user", sequence: 2 });
  const ended = event("hook", "2026-10-19T03:00:00Z", { kind: "lifecycle", status: null, sequence: 3 });
  const projects = [{ id: old.project_id, agent_tasks: [old], agent_state: "implementing" }];
  const restored = applyBufferedAgentEvents(projects, [waiting, ended]);
  assert.equal(currentAgentTasks(restored)[0].task.status, "waiting_for_user");
  assert.equal(hasUnknownCurrentTasks([{ id: "unknown", agent_tasks: null }]), true);
});

test("late replay cannot replace a live completed report with older attention", () => {
  const waiting = event("waiting", "2026-10-19T02:00:00Z", { status: "waiting_for_user", sequence: 2 });
  const done = event("done", "2026-10-19T03:00:00Z", { status: "completed", sequence: 3 });
  const projects = [{ id: done.project_id, agent_tasks: [done], agent_state: "completed" }];
  const restored = applyBufferedAgentEvents(projects, [waiting]);
  assert.equal(currentAgentTasks(restored)[0].task.status, "completed");
});

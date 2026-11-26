import assert from "node:assert/strict";
import test from "node:test";

import {
  agentReportLaneId,
  applyBufferedAgentEvents,
  createTimelineProjectLabel,
  currentAgentTasks,
  hasNoCurrentReports,
  mergeAgentEvents,
  timelineDecisionCopy,
  timelineProjectId,
  timelineWorktreeLocation,
} from "../app/agent-timeline-tools.mjs";

test("detached reports select a worktree lane only for a matching detached worktree in the current project", () => {
  const project = "/workspace/project/.git";
  const worktree = "/worktrees/feature copy";
  const repos = new Map([
    [worktree, { common_dir: project, detached: true }],
    ["/worktrees/reused", { common_dir: "/workspace/other/.git", detached: true }],
    ["/worktrees/attached", { common_dir: project, detached: false }],
  ]);

  for (const branch of ["(detached)", "", null]) {
    assert.equal(agentReportLaneId(project, { branch, worktree }, repos), `worktree:${worktree}`);
  }
  for (const path of ["/worktrees/removed", "/worktrees/reused", "/worktrees/attached", null]) {
    assert.equal(agentReportLaneId(project, { branch: "(detached)", worktree: path }, repos), null);
  }
  assert.equal(agentReportLaneId(project, { branch: "(detached)", worktree }, null), null);
  assert.equal(agentReportLaneId(project, { branch: "feature", worktree }, repos), "branch:feature");
});

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
});

test("an explicit null means no reports only within the selected project scope", () => {
  const empty = { id: "empty", agent_tasks: null };
  const reported = { id: "reported", agent_tasks: [event("status", null)] };
  const projects = [empty, reported];

  assert.equal(hasNoCurrentReports(projects, empty.id), true);
  assert.equal(hasNoCurrentReports(projects, reported.id), false);
  assert.equal(hasNoCurrentReports(projects, "missing"), false);
  assert.equal(hasNoCurrentReports(projects, null), false);
  assert.equal(hasNoCurrentReports([empty], null), true);
  assert.equal(hasNoCurrentReports([], null), false);
});

test("late replay cannot replace a live completed report with older attention", () => {
  const waiting = event("waiting", "2026-10-19T02:00:00Z", { status: "waiting_for_user", sequence: 2 });
  const done = event("done", "2026-10-19T03:00:00Z", { status: "completed", sequence: 3 });
  const projects = [{ id: done.project_id, agent_tasks: [done], agent_state: "completed" }];
  const restored = applyBufferedAgentEvents(projects, [waiting]);
  assert.equal(currentAgentTasks(restored)[0].task.status, "completed");
});

test("freshness partitions explicit reports at 24h without changing status", async () => {
  const { AGENT_REPORT_RECENT_MS, AGENT_DECISION_STATUSES, classifyCurrentAgentRows, agentReportFreshness } = await import("../app/agent-timeline-tools.mjs");
  const now = Date.parse("2026-11-13T12:00:00Z");
  const row = (status, age) => ({ project: { id: "project" }, task: event(status, new Date(now - age).toISOString(), { status }) });
  const recent = AGENT_DECISION_STATUSES.map((status) => row(status, AGENT_REPORT_RECENT_MS - 1));
  const old = AGENT_DECISION_STATUSES.map((status) => row(status, AGENT_REPORT_RECENT_MS));
  const active = ["investigating", "implementing", "testing", "reviewing"].map((status) => row(status, 0));
  const finished = [row("completed", 0), row("stopped", 0)];
  const oldActive = row("implementing", AGENT_REPORT_RECENT_MS);
  const rows = [...recent, ...old, ...active, ...finished, oldActive];
  const before = structuredClone(rows);
  const groups = classifyCurrentAgentRows(rows, now);
  assert.deepEqual(groups.decision.recent, recent);
  assert.equal(agentReportFreshness(recent[0].task.occurred_at, now), "recent");
  assert.equal(agentReportFreshness(old[0].task.occurred_at, now), "old");
  assert.equal(agentReportFreshness(null, now), "unknown");
  assert.deepEqual(groups.decision.old, old);
  assert.deepEqual(groups.decisionCounts, Object.fromEntries(AGENT_DECISION_STATUSES.map((status) => [status, 2])));
  assert.deepEqual(groups.active, active);
  assert.deepEqual(groups.finished, finished);
  assert.deepEqual(groups.old, [oldActive]);
  assert.deepEqual(rows, before);
});

test("missing and invalid report timestamps remain unknown rather than recent or old", async () => {
  const { classifyCurrentAgentRows } = await import("../app/agent-timeline-tools.mjs");
  const rows = [
    { task: event("waiting", null, { status: "waiting_for_user" }) },
    { task: event("active", "invalid", { status: "implementing" }) },
  ];
  const groups = classifyCurrentAgentRows(rows, Date.now());
  assert.deepEqual(groups.decision.unknown, [rows[0]]);
  assert.deepEqual(groups.unknown, [rows[1]]);
  assert.deepEqual(groups.active, []);
  assert.deepEqual(groups.old, []);
});

test("main and linked worktree URLs resolve to the same canonical project scope", () => {
  const main = "/workspace/thinkplatform";
  const linked = "/worktrees/thinkplatform-feature";
  const repos = new Map([[main, { common_dir: main }], [linked, { common_dir: main }]]);

  assert.equal(timelineProjectId(main, repos), main);
  assert.equal(timelineProjectId(linked, repos), main);
  assert.equal(timelineProjectId("/workspace/unknown", repos), null);
});

test("only duplicate project names include the canonical parent path", () => {
  const names = new Map([
    ["/workspace/thinkplatform", "thinkplatform"],
    ["/archives/thinkplatform", "thinkplatform"],
    ["/workspace/design_db", "design_db"],
  ]);
  const label = createTimelineProjectLabel(names);

  assert.equal(label("/workspace/thinkplatform", "thinkplatform"), "thinkplatform（/workspace）");
  assert.equal(label("/archives/thinkplatform", "thinkplatform"), "thinkplatform（/archives）");
  assert.equal(label("/workspace/design_db", "design_db"), "design_db");
});

test("decision copy preserves the summary and includes only explicit questions", () => {
  const header = "design_db / feature · 入力待ち";
  const summary = "確認結果を保存済み\n次の報告を待機中";
  const withSummary = `${header}\n報告要約: ${summary}`;

  assert.equal(timelineDecisionCopy(header, { summary, decision: null }), withSummary);
  assert.equal(timelineDecisionCopy(header, { summary, decision: { question: " " } }), withSummary);
  assert.equal(timelineDecisionCopy(header, { summary, decision: { question: "承認しますか？" } }),
    `${withSummary}\n質問: 承認しますか？`);
  assert.equal(timelineDecisionCopy(header, { summary: null, decision: null }), header);
});

test("worktree copy requires the exact reported path in the current project registry", () => {
  const project = "/workspace/design_db";
  const path = "/worktrees/design_db feature";
  const repos = new Map([
    [path, { common_dir: project, worktree_state: "ok" }],
    ["/worktrees/reused", { common_dir: "/archives/design_db", worktree_state: "ok" }],
    ["/worktrees/gone", { common_dir: project, worktree_state: "prunable" }],
  ]);

  assert.deepEqual(timelineWorktreeLocation(path, project, null), { command: null, note: "現在の台帳を取得中…" });
  const missing = { command: null, note: "現在の台帳にない" };
  assert.deepEqual(timelineWorktreeLocation(path, project, new Map()), missing);
  assert.deepEqual(timelineWorktreeLocation("/worktrees/removed", project, repos), missing);
  assert.deepEqual(timelineWorktreeLocation("/worktrees/reused", project, repos), missing);
  assert.deepEqual(timelineWorktreeLocation("/worktrees/gone", project, repos), {
    command: null, note: "作業ディレクトリが存在しないため移動できません",
  });
  assert.deepEqual(timelineWorktreeLocation(path, project, repos), { command: "cd '/worktrees/design_db feature'", note: null });
});

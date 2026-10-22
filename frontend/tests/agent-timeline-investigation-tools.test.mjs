import assert from "node:assert/strict";
import test from "node:test";

import {
  TIMELINE_KIND_ALL,
  TIMELINE_KIND_LIFECYCLE,
  TIMELINE_KIND_STATUS,
  TIMELINE_SORT_NEWEST,
  TIMELINE_SORT_OLDEST,
  TIMELINE_STATUS_ALL,
  TIMELINE_STATUS_UNKNOWN,
  filterTimelineCurrentRows,
  filterTimelineHistoryEvents,
  filterTimelineSnapshot,
  localTimelineCalendarDate,
  timelineDateRangeError,
  timelineHistoryCsv,
  timelineHistoryDetails,
  sortTimelineHistory,
} from "../app/agent-timeline-investigation-tools.mjs";

const projectA = { id: "/workspace/alpha", name: "Alpha", main_path: "/workspace/alpha" };
const projectB = { id: "/workspace/beta", name: "Beta", main_path: "/workspace/beta" };

const event = (event_id, occurred_at, extra = {}) => ({
  event_id,
  sequence: extra.sequence ?? 1,
  project_id: extra.project_id ?? projectA.id,
  worktree: extra.worktree ?? "/workspace/alpha",
  branch: extra.branch ?? "feature/one",
  kind: extra.kind ?? "status",
  status: extra.status ?? "implementing",
  run_state: extra.run_state ?? "active",
  phase: null,
  attention: null,
  outcome: null,
  action: extra.action ?? null,
  summary: extra.summary ?? null,
  occurred_at,
  observed_at: extra.observed_at ?? 1,
});

const filters = (overrides = {}) => ({
  query: "",
  projectId: "",
  status: TIMELINE_STATUS_ALL,
  kind: TIMELINE_KIND_ALL,
  startDate: "",
  endDate: "",
  sort: TIMELINE_SORT_NEWEST,
  ...overrides,
});

test("search covers project, branch, summary, and worktree while project selection stays exact", () => {
  const current = [
    { project: projectA, task: event("current-a", "2026-10-01T10:00:00+09:00", { summary: "worker handoff" }) },
    { project: projectB, task: event("current-b", "2026-10-01T11:00:00+09:00", { project_id: projectB.id, worktree: "/workspace/beta-worktree", branch: "main", summary: "release" }) },
  ];
  assert.equal(filterTimelineCurrentRows(current, filters({ query: "handoff", projectId: projectA.id })).length, 1);
  assert.equal(filterTimelineCurrentRows(current, filters({ query: "beta-worktree", projectId: projectB.id })).length, 1);
  assert.equal(filterTimelineCurrentRows(current, filters({ projectId: projectB.id, query: "alpha" })).length, 0);

  const history = [
    event("alpha", "2026-10-01T10:00:00+09:00", { summary: "Alpha report" }),
    event("beta", "2026-10-01T11:00:00+09:00", { project_id: projectB.id, worktree: "/workspace/beta-worktree" }),
  ];
  assert.deepEqual(
    filterTimelineHistoryEvents(history, filters({ query: "beta-worktree", projectId: projectB.id }), new Map([[projectA.id, projectA], [projectB.id, projectB]])).map((item) => item.event_id),
    ["beta"],
  );
});

test("status filtering uses explicit status only and lifecycle never becomes current", () => {
  const lifecycle = event("life", "2026-10-01T12:00:00+09:00", { kind: "lifecycle", status: null, action: "session_start" });
  const waiting = event("waiting", "2026-10-01T11:00:00+09:00", { status: "waiting_for_user" });
  const current = [{ project: projectA, task: waiting }, { project: projectA, task: lifecycle }];
  assert.deepEqual(filterTimelineCurrentRows(current, filters({ status: "waiting_for_user" })).map(({ task }) => task.event_id), ["waiting"]);
  assert.deepEqual(filterTimelineCurrentRows(current, filters({ status: TIMELINE_STATUS_UNKNOWN })), []);
  assert.deepEqual(filterTimelineHistoryEvents([waiting, lifecycle], filters({ status: "waiting_for_user" }), new Map([[projectA.id, projectA]])).map((item) => item.event_id), ["waiting"]);
  assert.deepEqual(filterTimelineHistoryEvents([waiting, lifecycle], filters({ status: TIMELINE_STATUS_UNKNOWN }), new Map([[projectA.id, projectA]])).map((item) => item.event_id), ["life"]);
});

test("kind and local calendar filters include boundaries and reject invalid ranges", () => {
  const status = event("status", "2026-10-01T00:00:00+09:00");
  const lifecycle = event("lifecycle", "2026-10-02T23:59:59+09:00", { kind: "lifecycle", status: null });
  const unknown = event("unknown", null, { kind: "lifecycle", status: null });
  const all = [status, lifecycle, unknown];
  const map = new Map([[projectA.id, projectA]]);
  assert.equal(localTimelineCalendarDate("2026-02-30T00:00:00+09:00"), null);
  assert.deepEqual(filterTimelineHistoryEvents(all, filters({ kind: TIMELINE_KIND_STATUS, startDate: "2026-10-01", endDate: "2026-10-02" }), map).map((item) => item.event_id), ["status"]);
  assert.deepEqual(filterTimelineHistoryEvents(all, filters({ kind: TIMELINE_KIND_LIFECYCLE, startDate: "2026-10-01", endDate: "2026-10-02" }), map).map((item) => item.event_id), ["lifecycle"]);
  assert.match(timelineDateRangeError("2026-10-03", "2026-10-02"), /以前/);
  assert.match(timelineDateRangeError("2026-02-30", null), /有効な日付/);
  assert.deepEqual(filterTimelineHistoryEvents(all, filters({ startDate: "2026-10-03", endDate: "2026-10-02" }), map), []);
  const details = timelineHistoryDetails(all, filters({ startDate: "2026-10-01", endDate: "2026-10-02" }), map);
  assert.equal(details.unknownDates, 1);
  assert.equal(details.finiteRangeUnknownDatesExcluded, true);
});

test("history sorting preserves the supplied snapshot and supports newest and oldest", () => {
  const older = event("older", "2026-10-01T10:00:00+09:00");
  const newer = event("newer", "2026-10-03T10:00:00+09:00");
  const input = [older, newer];
  assert.deepEqual(sortTimelineHistory(input, TIMELINE_SORT_NEWEST).map((item) => item.event_id), ["newer", "older"]);
  assert.deepEqual(sortTimelineHistory(input, TIMELINE_SORT_OLDEST).map((item) => item.event_id), ["older", "newer"]);
  assert.deepEqual(input.map((item) => item.event_id), ["older", "newer"]);
});

test("CSV exports only supplied filtered history and protects spreadsheet formulas", () => {
  const csv = timelineHistoryCsv([event("one", "2026-10-01T10:00:00+09:00", {
    summary: " =SUM(1,2)\n\"quoted\"",
    branch: "@branch",
  })]);
  assert.match(csv, /^\uFEFF"event_id","occurred_at","project_id"/u);
  assert.match(csv, /"' =SUM\(1,2\)\n""quoted"""/u);
  assert.match(csv, /"'@branch"/u);
  assert.equal(timelineHistoryCsv([]).endsWith("\r\n"), true);
});

test("filter parameters and project map are explicit, while invalid values never broaden the result", () => {
  assert.throws(() => filterTimelineCurrentRows([], { query: "" }), /provided explicitly/);
  assert.throws(() => filterTimelineHistoryEvents([], filters()), /projectById/);
  assert.throws(() => timelineHistoryDetails([], filters({ sort: undefined }), new Map()), /provided explicitly/);
  assert.throws(() => timelineDateRangeError(null, undefined), /provided explicitly/);
  const row = event("row", "2026-10-01T10:00:00+09:00");
  const map = new Map([[projectA.id, projectA]]);
  assert.deepEqual(filterTimelineHistoryEvents([row], filters({ status: "made-up" }), map), []);
  assert.deepEqual(filterTimelineSnapshot({ currentRows: [{ project: projectA, task: row }], history: [row] }, filters(), map).history.map((item) => item.event_id), ["row"]);
});

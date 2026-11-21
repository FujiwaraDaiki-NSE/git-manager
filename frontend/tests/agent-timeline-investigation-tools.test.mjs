import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

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
  historyBranch: null,
  status: TIMELINE_STATUS_ALL,
  kind: TIMELINE_KIND_ALL,
  startDate: "",
  endDate: "",
  sort: TIMELINE_SORT_NEWEST,
  ...overrides,
});

test("displayed history groups local days across pages and preserves the exported order", () => {
  const source = new URL("../app/agent-timeline.tsx", import.meta.url);
  const require = createRequire(source);
  const code = ts.transpileModule(readFileSync(source, "utf8") + "\nexport { HistoryList };", {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  runInNewContext(code, {
    exports,
    require: (name) => name.endsWith(".mjs") || !name.startsWith(".") ? require(name) : {},
  });
  const projectById = new Map();
  const input = [
    event("morning", new Date(2026, 9, 2, 0, 5).toISOString(), { summary: "morning report" }),
    event("evening", new Date(2026, 9, 1, 23, 55).toISOString(), { summary: "evening report" }),
    event("ignored", new Date(2026, 9, 3, 12).toISOString()),
  ];
  const olderPage = event("afternoon", new Date(2026, 9, 1, 17).toISOString(), { summary: "afternoon report" });
  const render = (events, sort) => {
    const { filtered } = timelineHistoryDetails(events, filters({ sort, query: "report" }), projectById);
    const html = renderToStaticMarkup(createElement(exports.HistoryList, { events: filtered, projectById }));
    return {
      dates: Array.from(html.matchAll(/<h4[^>]*><time dateTime="([^"]+)"/g), ([, date]) => date),
      rows: Array.from(html.matchAll(/>(morning|evening|afternoon) report</g), ([, id]) => id),
      csv: timelineHistoryCsv(filtered).split("\r\n").slice(1, -1).map((row) => row.split('"')[1]),
    };
  };
  const before = render(input, TIMELINE_SORT_NEWEST);
  assert.deepEqual(before.dates, ["2026-10-02", "2026-10-01"]);
  assert.deepEqual(before.rows, ["morning", "evening"]);
  const newest = render([...input, olderPage], TIMELINE_SORT_NEWEST);
  assert.deepEqual(newest.dates, before.dates);
  assert.deepEqual(newest.rows, ["morning", "evening", "afternoon"]);
  assert.deepEqual(newest.csv, newest.rows);
  const oldest = render([...input, olderPage], TIMELINE_SORT_OLDEST);
  assert.deepEqual(oldest.dates, newest.dates.toReversed());
  assert.deepEqual(oldest.rows, newest.rows.toReversed());
  assert.deepEqual(oldest.csv, oldest.rows);
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

test("branch history matches the exact project and branch across additional pages", () => {
  const first = event("first", "2026-10-01T11:00:00+09:00", { branch: "fix/a" });
  const prefix = event("prefix", "2026-10-01T11:00:00+09:00", { branch: "fix/ab" });
  const otherProject = event("other-project", "2026-10-01T11:00:00+09:00", { project_id: projectB.id, branch: "fix/a" });
  const older = event("older", "2026-09-30T11:00:00+09:00", { branch: "fix/a" });
  const map = new Map([[projectA.id, projectA], [projectB.id, projectB]]);
  const options = filters({ historyBranch: { projectId: projectA.id, branch: "fix/a" } });
  const history = [prefix, first, otherProject];
  assert.deepEqual(timelineHistoryDetails(history, options, map).filtered, [first]);
  assert.deepEqual(timelineHistoryDetails([...history, older], options, map).filtered, [first, older]);
  assert.deepEqual(filterTimelineHistoryEvents(history, filters(), map), history);
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

test("current and history search include decision question and options and accept null", () => {
  const reports = [
    { ...event("question", "2026-10-01T10:00:00+09:00"), decision: { question: "質問専用語", options: [], links: [] } },
    { ...event("option", "2026-10-01T10:00:00+09:00"), decision: { question: "判断内容", options: ["選択肢専用語"], links: [] } },
    { ...event("null", "2026-10-01T10:00:00+09:00"), decision: null },
  ];
  const rows = reports.map((task) => ({ project: projectA, task }));
  const map = new Map([[projectA.id, projectA]]);
  for (const [query, expected] of [["質問専用語", ["question"]], ["選択肢専用語", ["option"]], ["存在しない語", []], ["", ["question", "option", "null"]]]) {
    assert.deepEqual(filterTimelineCurrentRows(rows, filters({ query })).map(({ task }) => task.event_id), expected);
    assert.deepEqual(filterTimelineHistoryEvents(reports, filters({ query }), map).map((item) => item.event_id), expected);
  }
});

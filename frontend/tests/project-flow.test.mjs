import assert from "node:assert/strict";
import test from "node:test";

import {
  ancestryRows,
  flowEventKey,
  layoutFlowEvents,
  mobileEventAction,
  parseProjectUrl,
  shouldFoldMergedLane,
  updateProjectUrl,
} from "../app/project-flow.mjs";

function row(hash, parents = [], date = `2026-09-01T00:00:00+09:00`) {
  return { hash, parents, date };
}

test("ancestryRows returns only the real merge-base-to-head path in time order", () => {
  const rows = [
    row("head", ["middle"], "2026-09-03T00:00:00+09:00"),
    row("middle", ["base"], "2026-09-02T00:00:00+09:00"),
    row("base", ["old"], "2026-09-01T00:00:00+09:00"),
    row("old", [], "2026-08-01T00:00:00+09:00"),
  ];

  assert.deepEqual(
    ancestryRows(rows, "head", "base").map((item) => item.hash),
    ["base", "middle", "head"],
  );
});

test("merge path chooses the parent that reaches the explicit base", () => {
  const rows = [
    row("head", ["side", "main"], "2026-09-03T00:00:00+09:00"),
    row("side", ["side-base"], "2026-09-02T00:00:00+09:00"),
    row("main", ["base"], "2026-09-02T00:00:00+09:00"),
    row("side-base"),
    row("base"),
  ];

  assert.deepEqual(
    ancestryRows(rows, "head", "base").map((item) => item.hash),
    ["base", "main", "head"],
  );
});

test("URL state is restored and updated without dropping the project path", () => {
  const parsed = parseProjectUrl("?path=%2Fworkspace%2Frepo&tab=activity&range=7d&event=abc&lane=branch%3Afeature&at=35");
  assert.deepEqual(parsed, {
    path: "/workspace/repo",
    tab: "activity",
    range: "7d",
    event: "abc",
    lane: "branch:feature",
    at: 35,
  });
  const next = updateProjectUrl(
    "http://localhost/project?path=%2Fworkspace%2Frepo&tab=flow&range=current",
    { tab: "activity", event: "abc", lane: "branch:feature" },
  );
  assert.equal(
    next,
    "/project?path=%2Fworkspace%2Frepo&tab=activity&range=current&event=abc&lane=branch%3Afeature",
  );
  assert.equal(parseProjectUrl(next.split("?")[1] ? `?${next.split("?")[1]}` : "").path, "/workspace/repo");
});

test("flow events are chronological, keyed by lane, and have distinct hit centers", () => {
  const events = [
    { id: flowEventKey("branch:feature", "late"), x: 50, row: row("late", [], "2026-09-03T00:00:00+09:00") },
    { id: flowEventKey("branch:feature", "early"), x: 50, row: row("early", [], "2026-09-02T00:00:00+09:00") },
  ];
  const positioned = layoutFlowEvents(events, 440);
  assert.deepEqual(positioned.map((item) => item.row.hash), ["early", "late"]);
  assert.ok(positioned[1].hitX - positioned[0].hitX >= 10);
  assert.notEqual(flowEventKey("branch:feature", "same"), flowEventKey("branch:other", "same"));
});

test("mobile touch activation keeps the first tap as preview and the second as selection", () => {
  assert.equal(mobileEventAction({ isMobile: true, isTouch: true, previewAtPointerDown: false }), "preview");
  assert.equal(mobileEventAction({ isMobile: true, isTouch: true, previewAtPointerDown: true }), "select");
  assert.equal(mobileEventAction({ isMobile: false, isTouch: true, previewAtPointerDown: false }), "select");
});

test("merged folding keeps checked-out lanes visible", () => {
  assert.equal(shouldFoldMergedLane({ merged: true, is_worktree: true, dirty: false, conflict: false }), false);
  assert.equal(shouldFoldMergedLane({ merged: true, is_worktree: false, dirty: false, conflict: false }), true);
  assert.equal(shouldFoldMergedLane({ merged: null, is_worktree: false, dirty: false, conflict: false }), false);
});

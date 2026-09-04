import assert from "node:assert/strict";
import test from "node:test";

import {
  ancestryRows,
  flowEventKey,
  flowKeyboardAction,
  layoutFlowEvents,
  mergeBasePosition,
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

test("lane layout keeps the visible point centered on its timestamp at mobile width", () => {
  const width = 440;
  const makeEvent = (lane, hash, x, date) => ({
    id: flowEventKey(lane, hash),
    x,
    lane,
    row: row(hash, [], date),
  });
  const laneA = layoutFlowEvents([
    makeEvent("branch:a", "a-old", 50, "2026-09-01T00:00:00+09:00"),
    makeEvent("branch:a", "a-new", 50, "2026-09-02T00:00:00+09:00"),
  ], width);
  const laneB = layoutFlowEvents([
    makeEvent("branch:b", "b-old", 50, "2026-09-01T00:00:00+09:00"),
    makeEvent("branch:b", "b-new", 50, "2026-09-02T00:00:00+09:00"),
  ], width);

  for (const laneEvents of [laneA, laneB]) {
    assert.ok((laneEvents[1].hitX - laneEvents[0].hitX) * width / 100 >= 44);
    for (const event of laneEvents) {
      const pointCenter = event.hitX * width / 100 + event.pointOffset;
      assert.ok(Math.abs(pointCenter - event.x * width / 100) < 0.001);
    }
  }
  // Equal timestamps in separate lanes may share an x coordinate; spacing is
  // an intra-lane hit-area constraint, not a global event-count displacement.
  assert.equal(laneA[0].hitX, laneB[0].hitX);
});

test("merge-base remains anchored at the range edge when its commit is hidden", () => {
  const start = Date.parse("2026-09-03T00:00:00+09:00");
  const end = Date.parse("2026-09-04T00:00:00+09:00");
  assert.deepEqual(
    mergeBasePosition("2026-09-09T00:00:00+09:00", start, end),
    { x: 100, outside: true, available: true },
  );
  assert.deepEqual(
    mergeBasePosition("2026-09-02T00:00:00+09:00", start, end),
    { x: 0, outside: true, available: true },
  );
  assert.deepEqual(
    mergeBasePosition("2026-09-03T12:00:00+09:00", start, end),
    { x: 50, outside: false, available: true },
  );
});

test("arrow keys only move focus while Enter and Space select", () => {
  assert.equal(flowKeyboardAction("ArrowLeft"), "move");
  assert.equal(flowKeyboardAction("ArrowUp"), "move");
  assert.equal(flowKeyboardAction("Enter"), "select");
  assert.equal(flowKeyboardAction(" "), "select");
  assert.equal(flowKeyboardAction("Escape"), "none");
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
  assert.equal(shouldFoldMergedLane({ merged: null, worktree_state: "prunable", is_worktree: false, dirty: false, conflict: false }), true);
  assert.equal(shouldFoldMergedLane({ merged: null, worktree_state: "prunable", is_worktree: true, dirty: false, conflict: false }), false);
  assert.equal(shouldFoldMergedLane({ merged: null, worktree_state: "locked", is_worktree: false, dirty: false, conflict: false }), false);
});

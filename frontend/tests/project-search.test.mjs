import assert from "node:assert/strict";
import test from "node:test";
import {
  activityMatchesSearch,
  compareActivityEvents,
  laneMatchesSearch,
  normalizedSearchQuery,
} from "../app/project-search.mjs";

test("lane search matches the branch, path, or lane name and tolerates missing values", () => {
  const lane = { name: "作業用 checkout", branch: "feature/search", path: "/repo/worktrees/search" };

  assert.equal(normalizedSearchQuery("  FEATURE/SEARCH  "), "feature/search");
  assert.equal(laneMatchesSearch(lane, "feature"), true);
  assert.equal(laneMatchesSearch(lane, "worktrees/search"), true);
  assert.equal(laneMatchesSearch(lane, "checkout"), true);
  assert.equal(laneMatchesSearch({ name: "main", branch: null, path: null }, "feature"), false);
  assert.equal(laneMatchesSearch(lane, ""), true);
});

test("activity search covers subject, summary, author, branch, and visible lane names", () => {
  const event = {
    subject: null,
    summary: "テスト結果を確認してください",
    author: "agent-7",
    agent_id: "agent-7",
    branch: "feature/search",
    lane_names: ["検索対応"],
  };

  assert.equal(activityMatchesSearch(event, "テスト結果"), true);
  assert.equal(activityMatchesSearch(event, "agent-7"), true);
  assert.equal(activityMatchesSearch(event, "feature/search"), true);
  assert.equal(activityMatchesSearch(event, "検索対応"), true);
  assert.equal(activityMatchesSearch(event, "未取得"), false);
});

test("activity ordering keeps unknown timestamps explicit and supports both directions", () => {
  const old = { id: "old", occurred_at: "2026-09-01T00:00:00Z", observed_at: 1 };
  const recent = { id: "recent", occurred_at: "2026-09-02T00:00:00Z", observed_at: 2 };
  const unknown = { id: "unknown", occurred_at: null, observed_at: 3 };

  assert.ok(compareActivityEvents(recent, old, "newest") < 0);
  assert.ok(compareActivityEvents(old, recent, "oldest") < 0);
  assert.ok(compareActivityEvents(recent, unknown, "newest") < 0);
  assert.ok(compareActivityEvents(unknown, recent, "oldest") > 0);
});

test("lane filters never treat unknown counts as a positive Git state", async () => {
  const { laneMatchesFilter } = await import("../app/project-search.mjs");
  const unknown = { dirty: null, conflict: null, upstream_ahead: null, upstream_behind: null, is_worktree: false };
  for (const filter of ["dirty", "conflict", "ahead", "behind", "worktree"]) assert.equal(laneMatchesFilter(unknown, filter), false);
  assert.equal(laneMatchesFilter({ ...unknown, dirty: true }, "dirty"), true);
  assert.equal(laneMatchesFilter({ ...unknown, upstream_ahead: 3 }, "ahead"), true);
  assert.equal(laneMatchesFilter({ ...unknown, upstream_behind: 2 }, "behind"), true);
  assert.equal(laneMatchesFilter(unknown, "bogus"), false);
});

test("work lanes sort attention before clean, and unknown dates after known dates", async () => {
  const { sortWorkLanes } = await import("../app/project-search.mjs");
  const clean = { name: "alpha", id: "a", error: null, dirty: false, conflict: false, last_commit: null };
  const dirty = { ...clean, name: "zeta", id: "z", dirty: true, last_commit: { date: "2026-09-29T00:00:00Z" } };
  const conflict = { ...clean, name: "beta", id: "b", conflict: true, last_commit: { date: "invalid" } };
  const lanes = [clean, dirty, conflict];
  assert.deepEqual(sortWorkLanes(lanes, "attention").map((lane) => lane.id), ["b", "z", "a"]);
  assert.deepEqual(sortWorkLanes(lanes, "latest").map((lane) => lane.id), ["z", "a", "b"]);
  assert.deepEqual(sortWorkLanes(lanes, "name").map((lane) => lane.id), ["a", "b", "z"]);
  assert.deepEqual(lanes.map((lane) => lane.id), ["a", "z", "b"]);
});

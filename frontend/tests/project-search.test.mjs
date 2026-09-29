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

import assert from "node:assert/strict";
import test from "node:test";

import {
  parseProjectUrl,
  shouldFoldMergedLane,
  uniqueLocalForCommit,
  updateProjectUrl,
} from "../app/project-flow.mjs";

test("URL state is restored and updated without dropping the project path", () => {
  const parsed = parseProjectUrl("?path=%2Fworkspace%2Frepo&tab=activity&range=7d&event=abc&lane=branch%3Afeature&at=35");
  assert.deepEqual(parsed, {
    path: "/workspace/repo",
    tab: "activity",
    range: "7d",
    merged: false,
    event: "abc",
    lane: "branch:feature",
    branchRow: null,
    at: 35,
    laneQuery: "", laneFilter: "all", laneOrder: "name",
    activityQuery: "", activityFilter: "all", activityOrder: "newest",
    invalidParams: [],
  });
  const next = updateProjectUrl(
    "http://localhost/project?path=%2Fworkspace%2Frepo&tab=flow&range=current",
    { tab: "activity", event: "abc", lane: "branch:feature", branchRow: "remote:origin/feature" },
  );
  assert.equal(
    next,
    "/project?path=%2Fworkspace%2Frepo&tab=activity&range=current&event=abc&lane=branch%3Afeature&branchRow=remote%3Aorigin%2Ffeature",
  );
  assert.equal(parseProjectUrl(new URL(next, "http://localhost").search).path, "/workspace/repo");
  assert.equal(parseProjectUrl("?merged=true").merged, true);
});

test("invalid project view parameters remain explicit", () => {
  assert.deepEqual(parseProjectUrl("?tab=bogus").invalidParams, ["tab"]);
  assert.deepEqual(parseProjectUrl("?at=101").invalidParams, ["at"]);
  assert.deepEqual(parseProjectUrl("?merged=false&at=0").invalidParams, []);
});

test("merged and prunable worktrees fold only when they are safe to hide", () => {
  assert.equal(shouldFoldMergedLane({ merged: true, is_worktree: true, dirty: false, conflict: false }), false);
  assert.equal(shouldFoldMergedLane({ merged: true, is_worktree: false, dirty: false, conflict: false }), true);
  assert.equal(shouldFoldMergedLane({ merged: null, is_worktree: false, dirty: false, conflict: false }), false);
  assert.equal(shouldFoldMergedLane({ merged: null, worktree_state: "prunable", is_worktree: false, dirty: false, conflict: false }), true);
  assert.equal(shouldFoldMergedLane({ merged: null, worktree_state: "prunable", is_worktree: true, dirty: false, conflict: false }), true);
  assert.equal(shouldFoldMergedLane({ merged: null, worktree_state: "prunable", is_worktree: true, dirty: true, conflict: false }), false);
  assert.equal(shouldFoldMergedLane({ merged: null, worktree_state: "locked", is_worktree: false, dirty: false, conflict: false }), false);
});

test("branch commit context chooses only an exact unique local HEAD", () => {
  const localAhead = { id: "lane-ahead", head: "ahead-head" };
  const localBehind = { id: "lane-behind", head: "behind-head" };
  assert.equal(uniqueLocalForCommit([localAhead, localBehind], "remote-head"), null);
  assert.equal(uniqueLocalForCommit([localAhead, localBehind], "ahead-head"), localAhead);
  assert.equal(uniqueLocalForCommit([localAhead, { id: "lane-ahead-copy", head: "ahead-head" }], "ahead-head"), null);
});

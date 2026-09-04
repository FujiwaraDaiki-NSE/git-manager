import test from "node:test";
import assert from "node:assert/strict";

import {
  baseDirtyCount,
  buildTimelineGeometry,
  classifyBranch,
  relativeTime,
  timelineWindow,
} from "../app/timeline.mjs";

const commit = (hash, timestamp, subject = hash) => ({
  hash,
  short: hash.slice(0, 7),
  subject,
  author: "Test",
  date: new Date(timestamp * 1000).toISOString(),
  timestamp,
});

const baseData = {
  base: { name: "main", ref: "origin/main", hash: "base2" },
  now: 2_000,
  trunk: [commit("base1", 1_000), commit("base2", 1_900)],
  branches: [],
  command: "git log --first-parent origin/main",
};

test("classifyBranch follows merged, working, behind, ready, synced priority", () => {
  assert.equal(classifyBranch({ merged: true, ahead: 1, behind: 1 }, 2_000).key, "merged");
  assert.equal(
    classifyBranch(
      { merged: false, ahead: 0, behind: 2, worktree: "/tmp/topic", commits: [commit("x", 1_999)] },
      2_000,
      new Set(),
    ).key,
    "working",
  );
  assert.equal(classifyBranch({ merged: false, ahead: 0, behind: 2, commits: [] }, 2_000).key, "behind");
  assert.equal(classifyBranch({ merged: false, ahead: 1, behind: 0, commits: [] }, 2_000).key, "ready");
  assert.equal(classifyBranch({ merged: false, ahead: 0, behind: 0, commits: [] }, 2_000).key, "synced");
});

test("recent work becomes ready when the 30-minute window expires", () => {
  const branch = { merged: false, ahead: 1, behind: 0, commits: [commit("recent", 1_000)] };
  assert.equal(classifyBranch(branch, 2_800).key, "working");
  assert.equal(classifyBranch(branch, 2_801).key, "ready");
});

test("dirty worktree wins over a stale branch and is exposed on the lane", () => {
  const branch = {
    name: "topic",
    hash: "topic1",
    worktree: "/tmp/topic",
    merge_base: "base1",
    fork_time: 1_000,
    ahead: 1,
    behind: 0,
    commits: [commit("topic1", 1_100)],
    commits_truncated: false,
    merged: false,
    merge_hash: null,
    merged_at: null,
  };
  const geometry = buildTimelineGeometry(
    { ...baseData, branches: [branch] },
    { range: "all", width: 600, dirtyWorktrees: new Map([["/tmp/topic", { entries: [{ path: "x" }] }]]) },
  );
  assert.equal(geometry.lanes[0].status.key, "working");
  assert.equal(geometry.lanes[0].dirtyCount, 1);
  assert.equal(geometry.lanes[0].points.find((point) => point.isHead).marker, "dirty-head");
  assert.equal(geometry.lanes[0].points.find((point) => point.isHead).branchName, "topic");
  assert.ok(geometry.lanes[0].route.length >= 3);
});

test("the base checkout contributes its dirty count to the trunk head", () => {
  const dirtyMain = { is_worktree: false, branch: "main", entries: [{ path: "README.md" }, { path: "app.ts" }] };
  const geometry = buildTimelineGeometry(
    baseData,
    { range: "all", width: 600, dirtyWorktrees: new Map([["/tmp/main", dirtyMain]]) },
  );
  assert.equal(baseDirtyCount(baseData, new Map([["/tmp/main", dirtyMain]])), 2);
  const head = geometry.trunk.points.find((point) => point.isBaseHead);
  assert.equal(head.marker, "dirty-head");
  assert.equal(head.dirtyCount, 2);
});

test("merged lane returns to the trunk at merged_at", () => {
  const branch = {
    name: "merged",
    hash: "topic1",
    worktree: null,
    merge_base: "base1",
    fork_time: 1_000,
    ahead: 1,
    behind: 0,
    commits: [commit("topic1", 1_100)],
    commits_truncated: false,
    merged: true,
    merge_hash: "merge1",
    merged_at: 1_800,
  };
  const geometry = buildTimelineGeometry({ ...baseData, branches: [branch] }, { range: "all", width: 600 });
  const merge = geometry.lanes[0].points.find((point) => point.kind === "merge");
  assert.equal(geometry.lanes[0].status.key, "merged");
  assert.equal(merge.hash, "merge1");
  assert.equal(geometry.lanes[0].route.at(-1).y, geometry.trunkY);
});

test("range window uses now as the right edge and rejects unknown ranges", () => {
  assert.deepEqual(timelineWindow(baseData, "24h"), { start: -84_400, end: 2_000 });
  assert.throws(() => timelineWindow(baseData, "tomorrow"), /unknown timeline range/);
});

test("relative time is compact and deterministic", () => {
  assert.equal(relativeTime(1_970, 2_000), "たった今");
  assert.equal(relativeTime(1_800, 2_000), "3分前");
  assert.equal(relativeTime(0, 2_000), "33分前");
  assert.equal(relativeTime(2_100, 2_000), "2分後");
});

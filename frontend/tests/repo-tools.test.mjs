import assert from "node:assert/strict";
import test from "node:test";

import {
  branchMatchesFilter,
  branchMatchesSearch,
  changedPathList,
  sortBranches,
  visibleBranches,
} from "../app/repo-tools.mjs";

const branch = (name, extra = {}) => ({
  name,
  hash: `${name}-hash`,
  upstream: null,
  track: null,
  date: "2026-09-01T00:00:00+09:00",
  current: false,
  merged: false,
  worktree: null,
  ...extra,
});

test("branch search covers name, upstream, and worktree while preserving unknown values", () => {
  const feature = branch("feature/search", { upstream: "origin/search", worktree: "/work/search" });
  assert.equal(branchMatchesSearch(feature, " SEARCH "), true);
  assert.equal(branchMatchesSearch(feature, "/work/"), true);
  assert.equal(branchMatchesSearch(branch("main", { upstream: null, worktree: null }), "origin"), false);
  assert.equal(branchMatchesSearch(branch("unknown", { upstream: undefined, worktree: undefined }), "undefined"), false);
  assert.equal(branchMatchesSearch(feature, ""), true);
});

test("branch filters require explicit known facts and keep merged visibility separate", () => {
  const current = branch("main", { current: true, worktree: "/repo" });
  const otherWorktree = branch("feature", { worktree: "/work/feature" });
  const untracked = branch("topic", { upstream: null });
  const tracked = branch("tracked", { upstream: "origin/tracked" });
  const unknown = branch("unknown", { upstream: undefined, worktree: undefined, current: undefined });
  assert.equal(branchMatchesFilter(current, "current"), true);
  assert.equal(branchMatchesFilter(otherWorktree, "worktree"), true);
  assert.equal(branchMatchesFilter(untracked, "untracked-upstream"), true);
  assert.equal(branchMatchesFilter(tracked, "untracked-upstream"), false);
  assert.equal(branchMatchesFilter(unknown, "worktree"), false);
  assert.equal(branchMatchesFilter(unknown, "untracked-upstream"), false);

  const merged = branch("merged", { merged: true });
  const mergedUnknownWorktree = branch("merged-unknown", { merged: true, worktree: undefined });
  assert.deepEqual(visibleBranches([merged, current], { query: "", filter: "all", showMerged: false, sort: "name" }).map((item) => item.name), ["main"]);
  assert.deepEqual(visibleBranches([mergedUnknownWorktree], { query: "", filter: "all", showMerged: false, sort: "name" }).map((item) => item.name), ["merged-unknown"]);
  assert.deepEqual(visibleBranches([merged, current], { query: "", filter: "all", showMerged: true, sort: "name" }).map((item) => item.name), ["main", "merged"]);
});

test("branch sorting puts missing or invalid dates last and does not mutate input", () => {
  const latest = branch("latest", { date: "2026-09-03T00:00:00Z" });
  const old = branch("old", { date: "2026-09-01T00:00:00Z" });
  const missing = branch("missing", { date: null });
  const invalid = branch("invalid", { date: "not-a-date" });
  const branches = [missing, latest, invalid, old];
  assert.deepEqual(sortBranches(branches, "date").map((item) => item.name), ["latest", "old", "invalid", "missing"]);
  assert.deepEqual(sortBranches(branches, "name").map((item) => item.name), ["invalid", "latest", "missing", "old"]);
  assert.deepEqual(branches.map((item) => item.name), ["missing", "latest", "invalid", "old"]);
});

test("visible branch results compose search, filters, merged visibility, and deterministic sorting", () => {
  const branches = [
    branch("main", { current: true, worktree: "/repo", date: "2026-09-03T00:00:00Z" }),
    branch("feature/search", { upstream: "origin/search", worktree: "/work/search", date: "2026-09-02T00:00:00Z" }),
    branch("old", { merged: true, date: "2026-09-01T00:00:00Z" }),
  ];
  assert.deepEqual(
    visibleBranches(branches, { query: "search", filter: "worktree", sort: "date" }).map((item) => item.name),
    ["feature/search"],
  );
});

test("changed path list copies only the currently visible paths in display order", () => {
  assert.equal(changedPathList([{ path: "src/a.ts" }, { path: "README.md" }]), "src/a.ts\nREADME.md");
  assert.equal(changedPathList([]), "");
});

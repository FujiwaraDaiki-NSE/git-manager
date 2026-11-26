import assert from "node:assert/strict";
import test from "node:test";

import {
  canDisplayProject,
  parseProjectUrl,
  projectRequestRange,
  resolveGitDetail,
  shouldFoldMergedLane,
  uniqueLocalForCommit,
  updateProjectUrl,
} from "../app/project-flow.mjs";

test("closing the Files detail keeps the loaded project visible during a range change", () => {
  const selected = "/project?path=/repo&tab=files&range=7d&event=abc123";
  const before = parseProjectUrl(new URL(selected, "http://localhost").search);
  const after = parseProjectUrl(new URL(updateProjectUrl(selected, { event: null }), "http://localhost").search);
  const loaded = { path: before.path, range: projectRequestRange(before) };
  assert.equal(loaded.range, "7d");
  assert.equal(projectRequestRange(after), "current");
  assert.equal(canDisplayProject(after, loaded), true);
  assert.equal(canDisplayProject({ ...after, path: "/another-repo" }, loaded), false);
  assert.equal(canDisplayProject({ ...after, tab: "activity", range: "all" }, loaded), false);
});

test("project URLs default to 7d while preserving an explicit current range", () => {
  assert.equal(parseProjectUrl("?path=%2Fworkspace%2Frepo").range, "7d");
  assert.equal(parseProjectUrl("?tab=flow").range, "7d");
  assert.equal(parseProjectUrl("?tab=flow&range=current").range, "current");
  assert.equal(parseProjectUrl("?tab=lanes&range=current").range, "current");
});

test("URL state is restored and updated without dropping the project path", () => {
  const parsed = parseProjectUrl("?path=%2Fworkspace%2Frepo&tab=activity&range=7d&event=abc&lane=branch%3Afeature&at=35");
  assert.deepEqual(parsed, {
    path: "/workspace/repo",
    tab: "activity",
    flowSection: "relations",
    range: "7d",
    merged: false,
    event: "abc",
    lane: "branch:feature",
    branchRow: null,
    relationRef: null,
    gitPath: null,
    gitTab: null,
    at: 35,
    laneQuery: "", laneFilter: "all", laneOrder: "name",
    laneAuthorFilter: "", laneUpstreamFilter: "all", laneAgentFilter: "all",
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

test("Git detail URLs restore only listed worktrees with a valid tab and preserve the work list on close", () => {
  const list = "/project?path=%2Frepo&tab=lanes&laneQuery=topic";
  const view = (href) => parseProjectUrl(new URL(href, "http://localhost").search);
  const gitPath = "/worktrees/topic branch";
  const worktrees = [{ path: "/repo" }, { path: gitPath }];
  for (const gitTab of ["status", "graph", "branches"]) {
    const url = updateProjectUrl(list, { gitPath, gitTab });
    assert.deepEqual(resolveGitDetail(view(url), worktrees), { path: gitPath, tab: gitTab });
    assert.equal(resolveGitDetail(view(url), [{ path: "/other-project" }]), null);
    assert.equal(updateProjectUrl(url, { gitPath: null, gitTab: null }), list);
  }
  assert.equal(resolveGitDetail(view(updateProjectUrl(list, { gitPath, gitTab: "unknown" })), worktrees), null);
  assert.equal(resolveGitDetail(view(updateProjectUrl(list, { gitPath })), worktrees), null);
});

test("invalid project view parameters remain explicit", () => {
  assert.deepEqual(parseProjectUrl("?tab=bogus").invalidParams, ["tab"]);
  assert.deepEqual(parseProjectUrl("?at=101").invalidParams, ["at"]);
  assert.deepEqual(parseProjectUrl("?merged=false&at=0").invalidParams, []);
});

test("relation links close details while preserving exact ref and display context", () => {
  const href = updateProjectUrl("/project?path=%2Frepo&range=7d&lane=branch%3Atopic&event=abc&branchRow=shared", {
    tab: "flow", lane: null, event: null, branchRow: null, relationRef: "refs/heads/topic",
  });
  const state = parseProjectUrl(new URL(href, "http://localhost").search);
  assert.equal(state.lane, null);
  assert.equal(state.event, null);
  assert.equal(state.branchRow, null);
  assert.equal(state.relationRef, "refs/heads/topic");
  assert.equal(state.path, "/repo");
  assert.equal(state.range, "7d");
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


test("file investigations are directly addressable without changing project identity", () => {
  const state = parseProjectUrl("?path=%2Fworkspace%2Frepo&tab=files&range=current");
  assert.equal(state.tab, "files");
  assert.equal(state.path, "/workspace/repo");
  assert.deepEqual(state.invalidParams, []);
  assert.equal(updateProjectUrl("/project?path=%2Fworkspace%2Frepo&tab=files", {tab: "info"}), "/project?path=%2Fworkspace%2Frepo&tab=info");
});

test("ファイル単独表示は current を要求し、コミット選択とアクティビティでは URL の期間を使う", () => {
  const files = "/project?path=%2Frepo&tab=files&range=all";
  const view = (url) => parseProjectUrl(new URL(url, "http://localhost").search);
  assert.equal(projectRequestRange(view(files)), "current");
  assert.equal(view(files).range, "all");
  assert.equal(projectRequestRange(view(updateProjectUrl(files, { event: "abc123" }))), "all");
  assert.equal(projectRequestRange(view(updateProjectUrl(files, { tab: "activity" }))), "all");
});

test("flow sections use URL defaults, preserve context, and reject unknown values", () => {
  assert.equal(parseProjectUrl("").flowSection, "relations");
  for (const flowSection of ["relations", "history", "notes"]) {
    const href = updateProjectUrl("/project?path=%2Frepo&event=abc&lane=topic", { flowSection });
    const state = parseProjectUrl(new URL(href, "http://localhost").search);
    assert.equal(state.flowSection, flowSection);
    assert.equal(state.event, "abc");
    assert.equal(state.lane, "topic");
    assert.deepEqual(state.invalidParams, []);
  }
  for (const value of ["unknown", ""]) {
    const state = parseProjectUrl(`?flowSection=${value}`);
    assert.equal(state.flowSection, value);
    assert.deepEqual(state.invalidParams, ["flowSection"]);
  }
});

test("lane filters restore URL values without replacing absent authors", () => {
 const values = { laneAuthorFilter: "__gitdash_lane_author__:Alice%20Smith", laneUpstreamFilter: "diverged", laneAgentFilter: "unknown" };
 const href = updateProjectUrl("/project?path=%2Frepo&laneQuery=topic&laneFilter=dirty", values);
 const state = parseProjectUrl(new URL(href, "http://localhost").search);
 for (const [key, value] of Object.entries(values)) assert.equal(state[key], value);
 assert.equal(state.laneQuery, "topic");
 assert.deepEqual(state.invalidParams, []);
 assert.deepEqual(parseProjectUrl("?laneAuthorFilter=__gitdash_lane_author__:%ZZ&laneUpstreamFilter=bad&laneAgentFilter=active").invalidParams.sort(), ["laneAgentFilter", "laneAuthorFilter", "laneUpstreamFilter"]);
});

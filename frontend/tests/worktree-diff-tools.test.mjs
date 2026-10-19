import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorktreeDiffQuery,
  sameWorktreeDiffRequest,
  worktreeExcludedLabel,
  worktreePatchDownloadName,
  worktreePatchDownloadStatus,
  worktreeStageLabel,
} from "../app/worktree-diff-tools.mjs";

test("worktree diff query always carries the explicit scope and whitespace choice", () => {
  const query = new URLSearchParams(buildWorktreeDiffQuery("/tmp/repo", "staged", null, false));
  assert.equal(query.get("path"), "/tmp/repo");
  assert.equal(query.get("stage"), "staged");
  assert.equal(query.get("file"), "");
  assert.equal(query.get("ignoreWhitespace"), "false");

  const fileQuery = new URLSearchParams(buildWorktreeDiffQuery("/tmp/repo", "unstaged", "a[glob].txt", true));
  assert.equal(fileQuery.get("file"), "a[glob].txt");
  assert.equal(fileQuery.get("ignoreWhitespace"), "true");
});

test("worktree diff inputs reject implicit or invalid fallback values", () => {
  assert.throws(() => buildWorktreeDiffQuery("/repo", "staged", "", false), TypeError);
  assert.throws(() => buildWorktreeDiffQuery("/repo", "other", null, false), RangeError);
  assert.throws(() => buildWorktreeDiffQuery("/repo", "staged", null, "false"), TypeError);
  assert.throws(() => buildWorktreeDiffQuery("", "staged", null, false), TypeError);
  assert.throws(() => worktreePatchDownloadName({ stage: "staged", file: "", patch_truncated: false }), TypeError);
});

test("the result request comparison keeps path, stage, file, and whitespace explicit", () => {
  const request = { path: "/repo", stage: "staged", file: null, ignoreWhitespace: false };
  assert.equal(sameWorktreeDiffRequest(request, { ...request }), true);
  assert.equal(sameWorktreeDiffRequest(request, { ...request, stage: "unstaged" }), false);
  assert.equal(sameWorktreeDiffRequest(request, { ...request, file: "a.txt" }), false);
  assert.equal(sameWorktreeDiffRequest(null, request), false);
});

test("stage labels and partial download names expose the actual scope", () => {
  assert.equal(worktreeStageLabel("staged"), "ステージ済み");
  assert.equal(worktreeStageLabel("unstaged"), "未ステージ");
  assert.equal(worktreePatchDownloadName({ stage: "staged", file: "src/a.ts", patch_truncated: false }), "worktree-staged-src_a.ts.patch");
  assert.equal(worktreePatchDownloadName({ stage: "unstaged", file: null, patch_truncated: true }), "worktree-unstaged-all-partial.patch");
  assert.match(worktreePatchDownloadStatus(true), /部分/);
  assert.match(worktreePatchDownloadStatus(false), /生パッチ/);
});

test("excluded metadata is described without implying an empty tracked diff", () => {
  assert.equal(worktreeExcludedLabel({ untracked: ["new.txt"], conflict: [], not_in_diff: [] }), "未追跡 1 件はGitの差分対象外です。");
  assert.equal(worktreeExcludedLabel({ untracked: [], conflict: ["conflict"], not_in_diff: ["gone"] }), "競合 1 件、差分対象外 1 件はGitの差分対象外です。");
  assert.equal(worktreeExcludedLabel({ untracked: [], conflict: [], not_in_diff: [] }), null);
});

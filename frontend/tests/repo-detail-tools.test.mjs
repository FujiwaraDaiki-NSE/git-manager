import test from "node:test";
import assert from "node:assert/strict";
import { statusDiffStages, hasNoUncommittedChanges, responseErrorMessage } from "../app/repo-detail-tools.mjs";

test("差分は絞り込み段階に従う", () => {
  assert.deepEqual(statusDiffStages("MM", "staged"), ["staged"]);
  assert.deepEqual(statusDiffStages("MM", "unstaged"), ["unstaged"]);
  assert.deepEqual(statusDiffStages("MM", "all"), ["staged", "unstaged"]);
  assert.deepEqual(statusDiffStages("M.", "all"), ["staged"]);
  assert.deepEqual(statusDiffStages(".M", "all"), ["unstaged"]);
  for (const xy of ["??", "UU"]) assert.deepEqual(statusDiffStages(xy, "all"), []);
});

test("変更なしは他バッジと独立し、未取得・失敗・pending・prunableを除外する", () => {
  const repo = { entries: [], ahead: 2, behind: 1, stashes: 1 };
  assert.equal(hasNoUncommittedChanges(repo), true);
  for (const extra of [{ entries: undefined }, { entries: [{ xy: "MM" }] }, { error: "失敗" }, { pending: true }, { worktree_state: "prunable" }]) {
    assert.equal(hasNoUncommittedChanges({ ...repo, ...extra }), false);
  }
});

test("文字列detailを優先し、それ以外はHTTPステータスを表示する", () => {
  assert.equal(responseErrorMessage(404, { detail: "コミットが見つかりません" }), "コミットが見つかりません");
  for (const body of [null, {}, { detail: [] }, "invalid"]) assert.equal(responseErrorMessage(422, body), "HTTP 422");
});

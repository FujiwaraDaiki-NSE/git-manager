import test from "node:test";
import assert from "node:assert/strict";
import { fetchCommitDetail, statusDiffStages, hasNoUncommittedChanges, responseErrorMessage } from "../app/repo-detail-tools.mjs";

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

test("コミット詳細の取得は404の理由と通信失敗を区別し、再試行で詳細を返す", async (t) => {
  const signal = new AbortController().signal;
  const detail = { hash: "abc123" };
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json(detail));
  fetch.mock.mockImplementationOnce(async () => Response.json({ detail: "コミットが見つかりません" }, { status: 404 }), 0);
  fetch.mock.mockImplementationOnce(async () => { throw new TypeError("Failed to fetch"); }, 1);
  await assert.rejects(fetchCommitDetail("/repo", detail.hash, signal), /コミットが見つかりません/);
  await assert.rejects(fetchCommitDetail("/repo", detail.hash, signal), /通信に失敗しました/);
  assert.deepEqual(await fetchCommitDetail("/repo", detail.hash, signal), detail);
});

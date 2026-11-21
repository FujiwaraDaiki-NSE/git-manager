import test from "node:test";
import assert from "node:assert/strict";
import { resolveBranchCommits } from "../app/branch-commits.mjs";

test("shared history restores each row exactly in its own order", () => {
  const a = { hash: "a", subject: "shared", parents: ["b"] };
  const b = { hash: "b", subject: "root", parents: [] };
  const project = { branch_commits: [a, b] };
  for (const [indices, expected] of [[[0, 1], [a, b]], [[1, 0], [b, a]], [[], []], [[0], [a]]]) {
    assert.deepEqual(resolveBranchCommits(project, { commit_indices: indices }), expected);
  }
  assert.throws(() => resolveBranchCommits(project, { commit_indices: [2] }), /Missing branch commit/);
});

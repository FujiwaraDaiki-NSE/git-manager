import test from "node:test";
import assert from "node:assert/strict";
import { resolveBranchCommits } from "../app/branch-commits.mjs";

test("shared history restores each row exactly in its own order", () => {
  const a = { hash: "a", subject: "shared", parents: ["b"] };
  const b = { hash: "b", subject: "root", parents: [] };
  const project = { branch_commits: { a, b } };
  for (const expected of [[a, b], [b, a], [], [a]]) {
    assert.deepEqual(resolveBranchCommits(project, { commit_hashes: expected.map(c => c.hash) }), expected);
  }
  assert.throws(() => resolveBranchCommits(project, { commit_hashes: ["missing"] }), /Missing branch commit/);
});

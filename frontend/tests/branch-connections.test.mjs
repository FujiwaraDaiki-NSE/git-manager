import assert from "node:assert/strict";
import test from "node:test";

import {
  branchConnectionEvidenceLabel,
  buildBranchConnectionPaths,
  selectBranchConnections,
} from "../app/branch-connections.mjs";

const merge = {
  id: "merge-1",
  kind: "merge",
  source_row_id: "feature",
  target_row_id: "main",
  evidence: "pull_request",
  commit_hash: "abc",
  pr_number: 12,
  pr_url: "https://example.test/pr/12",
  label: "feature → main",
};
const branch = {
  id: "branch-1",
  kind: "branch",
  source_row_id: "main",
  target_row_id: "topic",
  evidence: "merge_base",
  commit_hash: null,
  pr_number: null,
  pr_url: null,
  label: "main → topic",
};

test("focus keeps connected edges and identifies filtered counterparts", () => {
  const result = selectBranchConnections([merge, branch], "main", new Set(["main", "feature"]));
  assert.deepEqual(result.focused.map((edge) => edge.id), ["merge-1", "branch-1"]);
  assert.deepEqual(result.visible.map((edge) => edge.id), ["merge-1"]);
  assert.deepEqual(result.offscreen.map((edge) => edge.id), ["branch-1"]);
  assert.deepEqual([...result.relatedRowIds], ["feature", "main", "topic"]);
});

test("paths preserve source to target direction when target is above source", () => {
  const paths = buildBranchConnectionPaths(
    [merge],
    new Map([
      ["feature", { id: "feature", x: 56, y: 180 }],
      ["main", { id: "main", x: 56, y: 40 }],
    ]),
  );
  assert.equal(paths.length, 1);
  assert.equal(paths[0].sourceY, 180);
  assert.equal(paths[0].targetY, 40);
  assert.match(paths[0].d, /M 56 180/);
  assert.match(paths[0].d, /56 40$/);
  assert.match(paths[0].d, /C 44 180, 44 40/);
});

test("both filtered counterparts stay actionable in the relation list", () => {
  const result = selectBranchConnections([merge], "feature", new Set());
  assert.deepEqual(result.visible, []);
  assert.deepEqual(result.offscreen.map((edge) => edge.id), ["merge-1"]);
  assert.deepEqual([...result.relatedRowIds], ["feature", "main"]);
});

test("evidence labels distinguish PR merges from inferred ancestry", () => {
  assert.equal(branchConnectionEvidenceLabel(merge), "実際のPRマージ");
  assert.equal(branchConnectionEvidenceLabel(branch), "分岐の推定（共通祖先）");
});

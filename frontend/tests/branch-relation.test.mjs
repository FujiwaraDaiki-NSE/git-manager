import assert from "node:assert/strict";
import test from "node:test";

import {
  COMMON_ANCESTOR_MARKER,
  MAX_BRANCH_RELATION_GROUPS,
  MAX_BRANCH_NAMES_PER_GROUP,
  MAX_SUMMARY_HEIGHT,
  SUMMARY_ROW_HEIGHT,
  buildBranchRelationGeometry,
  buildBranchRelationSummary,
} from "../app/branch-relation.js";

function row(hash, parents = [], lane = 0, refs = []) {
  return {
    hash,
    short: hash,
    parents,
    refs,
    author: "fixture",
    date: "2026-09-03T00:00:00+09:00",
    subject: hash,
    lane,
    in_lanes: [],
    through: [],
    out_lanes: [],
    is_head: false,
    is_merge: parents.length > 1,
  };
}

function graph(rows, branchHeads, defaultBranch = "main", defaultLane = 0) {
  return {
    rows,
    max_lane: Math.max(...rows.map((item) => item.lane), 0),
    head_lane: defaultLane,
    default_branch: defaultBranch,
    default_lane: defaultLane,
    branch_heads: branchHeads,
    truncated: false,
    command: "git log --oneline --graph --all",
  };
}

function head(name, hash) {
  return { name, hash };
}

test("normal divergence uses the displayed parent paths", () => {
  const summary = buildBranchRelationSummary(
    graph(
      [
        row("main-head", ["base"], 0, [
          { name: "origin/main", kind: "remote" },
        ]),
        row("feature-head", ["base"], 1),
        row("base"),
      ],
      [head("main", "main-head"), head("feature", "feature-head")],
    ),
  );

  assert.ok(summary);
  assert.deepEqual(summary.branches.map((relation) => relation.names), [
    ["main"],
    ["feature"],
  ]);
  const feature = summary.branches[1];
  assert.equal(feature.commonAncestorHash, "base");
  assert.deepEqual(feature.branchPath.map((item) => item.hash), [
    "base",
    "feature-head",
  ]);
  assert.deepEqual(feature.defaultPath.map((item) => item.hash), [
    "base",
    "main-head",
  ]);

  const geometry = buildBranchRelationGeometry(summary);
  assert.equal(geometry.relations[0].samePath, true);
  assert.equal(geometry.relations[0].branchLine, false);
  assert.equal(geometry.relations[0].defaultLine, false);
  assert.deepEqual(COMMON_ANCESTOR_MARKER, {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    radius: 3,
  });
});

test("geometry keeps row distance and local default-branch paths", () => {
  const rows = [
    row("main-head", ["base"], 1, [
      { name: "main", kind: "branch" },
    ]),
    row("feature-head", ["base"], 2),
  ];
  for (let index = 0; index < 8; index += 1) {
    rows.push(row(`unrelated-${index}`, [], 3));
  }
  rows.push(row("base", [], 1, [{ name: "origin/main", kind: "remote" }]));
  const summary = buildBranchRelationSummary(
    graph(rows, [head("main", "main-head"), head("feature", "feature-head")]),
  );

  assert.ok(summary);
  const geometry = buildBranchRelationGeometry(summary);
  const main = geometry.relations.find((relation) =>
    relation.relation.names.includes("main"),
  );
  assert.ok(main);
  assert.equal(geometry.minIndex, 0);
  assert.equal(geometry.maxIndex, 10);
  assert.equal(geometry.height, MAX_SUMMARY_HEIGHT);
  assert.equal(geometry.scaleY, MAX_SUMMARY_HEIGHT / (11 * SUMMARY_ROW_HEIGHT));
  assert.equal(main.branchPoints.length, 2);
  assert.equal(main.defaultPoints.length, 1);
  assert.equal(main.hasPath, true);
  assert.equal(main.branchLine, true);
  assert.equal(main.defaultLine, false);
  assert.equal(main.showCommonAncestor, true);
  assert.equal(main.branchPoints[0].x, 22);
  assert.equal(main.defaultPoints[0].x, 8);
  assert.equal(main.branchPoints.at(-1).x, 22);
  assert.equal(main.defaultPoints.at(-1).x, 8);
  const expectedHeadY = SUMMARY_ROW_HEIGHT / 2 * geometry.scaleY;
  const expectedBaseY =
    (10 * SUMMARY_ROW_HEIGHT + SUMMARY_ROW_HEIGHT / 2) * geometry.scaleY;
  assert.ok(Math.abs(main.branchPoints.at(-1).y - expectedHeadY) < 1e-9);
  assert.ok(Math.abs(main.branchPoints[0].y - expectedBaseY) < 1e-9);
  assert.ok(main.branchPoints.at(-1).y < main.branchPoints[0].y);
  assert.notEqual(main.branchPoints.at(-1).y, main.defaultPoints.at(-1).y);
});

test("a branch at the default HEAD is represented as a zero-length path", () => {
  const summary = buildBranchRelationSummary(
    graph(
      [
        row("head", [], 0, [{ name: "origin/main", kind: "remote" }]),
      ],
      [head("main", "head"), head("topic", "head")],
    ),
  );

  assert.ok(summary);
  assert.equal(summary.branches.length, 1);
  assert.deepEqual(summary.branches[0].names, ["main", "topic"]);
  assert.equal(summary.branches[0].commonAncestorHash, "head");
  assert.deepEqual(summary.branches[0].branchPath.map((item) => item.hash), [
    "head",
  ]);
  assert.deepEqual(summary.branches[0].defaultPath.map((item) => item.hash), [
    "head",
  ]);
});

test("criss-cross histories keep merge-base candidates and exclude older common ancestors", () => {
  const summary = buildBranchRelationSummary(
    graph(
      [
        row("main-head", ["main-merge"], 0, [
          { name: "origin/main", kind: "remote" },
        ]),
        row("main-merge", ["a", "b"], 0),
        row("feature-head", ["feature-merge"], 1),
        row("feature-merge", ["b", "a"], 1),
        row("a", ["root"], 0),
        row("b", ["root"], 1),
        row("root"),
      ],
      [head("main", "main-head"), head("feature", "feature-head")],
    ),
  );

  assert.ok(summary);
  const feature = summary.branches.find((relation) =>
    relation.names.includes("feature"),
  );
  assert.ok(feature);
  assert.ok(["a", "b"].includes(feature.commonAncestorHash));
  assert.notEqual(feature.commonAncestorHash, "root");
  assert.ok(feature.branchPath);
  assert.ok(feature.defaultPath);
});

test("same HEADs are aggregated and unique groups have an explicit display limit", () => {
  const sameHead = Array.from({ length: 1000 }, (_, index) =>
    head(index === 0 ? "main" : `topic-${index}`, "head"),
  );
  const sameHeadSummary = buildBranchRelationSummary(
    graph(
      [row("head", [], 0, [{ name: "origin/main", kind: "remote" }])],
      sameHead,
    ),
  );

  assert.ok(sameHeadSummary);
  assert.equal(sameHeadSummary.branches.length, 1);
  assert.equal(sameHeadSummary.branches[0].names.length, 1000);
  assert.equal(MAX_BRANCH_NAMES_PER_GROUP, 6);

  const rows = [row("default", [], 0, [{ name: "origin/main", kind: "remote" }])];
  const branchHeads = [head("main", "default")];
  for (let index = 0; index < MAX_BRANCH_RELATION_GROUPS + 9; index += 1) {
    const hash = `head-${index}`;
    rows.push(row(hash, [], index + 1));
    branchHeads.push(head(`topic-${index}`, hash));
  }
  const limitedSummary = buildBranchRelationSummary(
    graph(rows, branchHeads),
  );

  assert.ok(limitedSummary);
  assert.equal(limitedSummary.branches.length, MAX_BRANCH_RELATION_GROUPS);
  assert.equal(
    limitedSummary.omittedGroups,
    branchHeads.length - MAX_BRANCH_RELATION_GROUPS,
  );
  assert.equal(limitedSummary.omittedBranches, limitedSummary.omittedGroups);
});

test("unavailable default HEAD does not invent a path", () => {
  const summary = buildBranchRelationSummary(
    graph(
      [row("feature-head"), row("other-head", [], 1)],
      [head("main", "outside-range"), head("feature", "feature-head"), head("other", "other-head")],
    ),
  );

  assert.ok(summary);
  assert.match(summary.unavailableReason, /表示範囲外/);
  assert.ok(summary.branches.every((relation) => relation.branchPath === null));
  assert.ok(summary.branches.every((relation) => relation.defaultPath === null));
});

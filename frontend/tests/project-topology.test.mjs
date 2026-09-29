import assert from "node:assert/strict";
import test from "node:test";
import { topologyConnections, topologyRelationTimes } from "../app/project-flow.mjs";
const lanes = [{id: "main"}, {id: "feature"}];
const rows = [{hash: "b", date: new Date(10).toISOString()}, {hash: "c", date: new Date(20).toISOString()}, {hash: "m", date: new Date(30).toISOString()}];
const relations = [
  {kind: "branch", source_parent: "b", commit_hash: "c", source_lane_id: "main", target_lane_id: "feature"},
  {kind: "merge", source_parent: "c", commit_hash: "m", source_lane_id: "feature", target_lane_id: "main"},
];
test("branch and merge arrows terminate at receiving commit", () => {
  const links = topologyConnections(relations, lanes, rows, 0, 40, 40, 440, 88);
  assert.equal(links.length, 2);
  assert.equal(links[0].targetIndex, 1);
  assert.equal(links[1].targetIndex, 0);
  for (const link of links) {
    const endX = link.path.split(" H ").at(-1);
    assert.ok(link.arrow.includes(`L ${endX} ${(link.targetIndex + .5) * 88}`));
  }
});
test("equal and reversed timestamps retain arrows", () => {
  for (const date of [20, 5]) {
    const adjusted = rows.map(row => row.hash === "m" ? {...row, date: new Date(date).toISOString()} : row);
    const links = topologyConnections(relations, lanes, adjusted, 0, 40, 40, 440, 88);
    assert.equal(links.length, 2);
    assert.equal(links[1].targetIndex, 0);
    assert.equal(links[1].clockSkew, date < 20);
    assert.ok(!links[1].path.includes("NaN"));
    assert.ok(links[1].arrow);
  }
});
test("historical selection and missing parents do not fabricate lines", () => {
  assert.equal(topologyConnections(relations, lanes, rows, 0, 40, 25, 440, 88).length, 1);
  assert.equal(topologyConnections(relations, lanes, rows.slice(1), 0, 40, 40, 440, 88).length, 1);
  assert.equal(topologyConnections(relations, lanes, rows, 15, 40, 40, 440, 88)[0].outside, true);
});

test("head-only view retains a fork older than either current tip", () => {
  const timed = relations.map((edge) => ({...edge, occurred_at: rows.find(row => row.hash === edge.commit_hash).date}));
  const times = topologyRelationTimes(timed, "current", 40);
  const min = Math.min(35, ...times);
  assert.equal(min, 20);
  const links = topologyConnections(relations, lanes, rows, min, 40, 40, 440, 88);
  assert.equal(links.filter(link => link.kind === "branch").length, 1);
  assert.equal(links.filter(link => link.kind === "merge").length, 1);
});

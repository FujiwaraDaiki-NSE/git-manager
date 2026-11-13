import assert from "node:assert/strict";
import test from "node:test";

import {
  filterHistoricalEdges,
  filterVisibleReferencePairs,
  sortVisibleReferencePairs,
  visiblePairsJson,
  visiblePairsMarkdown,
} from "../app/branch-relations-ui-tools.mjs";

const refs = [
  { id: "refs/heads/main", name: "main", kind: "local", hash: "a".repeat(40) },
  { id: "refs/remotes/origin/main", name: "origin/main", kind: "remote", hash: "a".repeat(40) },
  { id: "refs/heads/topic", name: "topic", kind: "local", hash: "b".repeat(40) },
  { id: "detached:/tmp/wt", name: "detached HEAD", kind: "detached", hash: "c".repeat(40) },
];
const refsById = new Map(refs.map((ref) => [ref.id, ref]));
const pair = (otherRefId, relation, selectedOnly, otherOnly, reason = null) => ({
  otherRefId,
  relation,
  selectedOnly,
  otherOnly,
  mergeBases: [],
  pair: { reason },
});

test("pair filters use exact relation and other ref kind values", () => {
  const pairs = [
    pair(refs[1].id, "equal", 0, 0),
    pair(refs[2].id, "diverged", 4, 2),
    pair(refs[3].id, "unknown", null, null, "shallow_history"),
  ];
  assert.equal(filterVisibleReferencePairs(pairs, refsById, { query: "", relation: "diverged", otherKind: "" }).length, 1);
  assert.equal(filterVisibleReferencePairs(pairs, refsById, { query: "", relation: "", otherKind: "remote" }).length, 1);
  assert.equal(filterVisibleReferencePairs(pairs, refsById, { query: "", relation: "unknown", otherKind: "detached" })[0].otherRefId, refs[3].id);
  assert.equal(filterVisibleReferencePairs(pairs, refsById, { query: "shallow_history", relation: "", otherKind: "" }).length, 1);
  assert.equal(filterVisibleReferencePairs(pairs, refsById, { query: null, relation: null, otherKind: null }).length, 3);
  assert.throws(() => filterVisibleReferencePairs(pairs, refsById, { query: "" }), /relation/);
  assert.throws(() => filterVisibleReferencePairs(pairs, refsById, { query: "", relation: "", otherKind: 1 }), /otherKind/);
});

test("pair sorting is deterministic by name, semantic relation, or divergence", () => {
  const pairs = [
    pair(refs[2].id, "diverged", 4, 2),
    pair(refs[1].id, "equal", 0, 0),
    pair(refs[3].id, "unknown", null, null),
  ];
  assert.deepEqual(sortVisibleReferencePairs(pairs, refsById, "name").map((item) => item.otherRefId), [refs[3].id, refs[1].id, refs[2].id]);
  assert.deepEqual(sortVisibleReferencePairs(pairs, refsById, "relation").map((item) => item.relation), ["equal", "diverged", "unknown"]);
  assert.deepEqual(sortVisibleReferencePairs(pairs, refsById, "divergence").map((item) => item.otherRefId), [refs[1].id, refs[2].id, refs[3].id]);
});

test("historical filters require exact evidence and operation", () => {
  const edges = [
    { id: "pr", evidence: "pull_request", operation: "pull_request", source_ref_id: refs[2].id, target_ref_id: refs[0].id, label: "feature" },
    { id: "reflog", evidence: "reflog", operation: "merge", source_ref_id: refs[2].id, target_ref_id: refs[0].id, label: "merge" },
    { id: "base", evidence: "merge_base", operation: null, source_ref_id: refs[1].id, target_ref_id: refs[0].id, label: "base" },
  ];
  const rows = [];
  assert.deepEqual(filterHistoricalEdges(edges, refs, refs[0].id, { query: "", evidence: "reflog", operation: "", rows }).map((edge) => edge.id), ["reflog"]);
  assert.deepEqual(filterHistoricalEdges(edges, refs, refs[0].id, { query: "", evidence: "", operation: "pull_request", rows }).map((edge) => edge.id), ["pr"]);
  assert.deepEqual(filterHistoricalEdges(edges, refs, refs[0].id, { query: "feature", evidence: "", operation: "", rows }).map((edge) => edge.id), ["pr"]);
  assert.throws(() => filterHistoricalEdges(edges, refs, refs[0].id, { query: "", evidence: "", operation: "" }), /rows/);
  assert.throws(() => filterHistoricalEdges(edges, refs, refs[0].id, { query: "", evidence: "", operation: 1, rows }), /operation/);
});

test("JSON export records repository, selected ref, coverage, filters, and visible pairs", () => {
  const json = JSON.parse(visiblePairsJson({
    repository: "/repos/sample",
    selectedRef: refs[0],
    coverage: { ancestry: "祖先関係: 取得済み", reflog: "reflog: 一部取得" },
    filters: { query: "topic", relation: "diverged", other_kind: "local", sort: "name" },
    pairs: [pair(refs[2].id, "diverged", 4, 2)],
    refsById,
  }));
  assert.equal(json.repository, "/repos/sample");
  assert.equal(json.ref.id, refs[0].id);
  assert.equal(json.coverage.reflog, "reflog: 一部取得");
  assert.equal(json.filters.relation, "diverged");
  assert.equal(json.pairs[0].other_ref.name, "topic");
});

test("Markdown copy contains only the displayed pair rows", () => {
  const markdown = visiblePairsMarkdown({
    repository: "/repos/sample",
    selectedRef: refs[0],
    coverage: { ancestry: "complete", reflog: "available" },
    filters: { query: "", relation: null, other_kind: null, sort: "name" },
    pairs: [pair(refs[2].id, "diverged", 4, 2)],
    refsById,
  });
  assert.match(markdown, /# Git 関係比較: main/);
  assert.match(markdown, /\| topic（ローカル） `b{40}` \| 分岐中 \| 4 \| 2 \|/);
  assert.match(markdown, new RegExp("`" + "b".repeat(40) + "`"));
  assert.match(markdown, new RegExp("`" + "a".repeat(40) + "`"));
  assert.doesNotMatch(markdown, /origin\/main/);
});

test("relation lists limit filtered/sorted results without mutating or dropping later rows", async () => {
  const { visibleRelationRows, RELATION_PAIRS_PAGE_SIZE, RELATION_EVENTS_PAGE_SIZE, RELATION_UNRESOLVED_PAGE_SIZE } = await import("../app/branch-relations-ui-tools.mjs");
  const items = Array.from({ length: 45 }, (_, id) => ({ id }));
  assert.equal(visibleRelationRows(items, RELATION_PAIRS_PAGE_SIZE).length, 20);
  assert.equal(visibleRelationRows(items, RELATION_EVENTS_PAGE_SIZE).length, 10);
  assert.equal(visibleRelationRows(items, RELATION_UNRESOLVED_PAGE_SIZE).length, 20);
  assert.deepEqual(visibleRelationRows(items, 40), items.slice(0, 40));
  assert.deepEqual(visibleRelationRows(items, 60), items);
  assert.equal(items.length, 45);
  assert.deepEqual(visibleRelationRows([], 20), []);
  assert.throws(() => visibleRelationRows(items, undefined), /limit/);
  assert.throws(() => visibleRelationRows(items, 0), /limit/);

  const filtered = filterVisibleReferencePairs([
    ...Array.from({ length: 25 }, () => pair(refs[1].id, "equal", 0, 0)),
    pair(refs[2].id, "diverged", 4, 2),
  ], refsById, { query: "topic", relation: "diverged", otherKind: "local" });
  assert.equal(visibleRelationRows(sortVisibleReferencePairs(filtered, refsById, "name"), 20)[0].otherRefId, refs[2].id);
});

test("URL reference beyond the first page still selects its own comparisons before limiting", async () => {
  const { preferredReferenceId, selectReferencePairs } = await import("../app/branch-relations-tools.mjs");
  const { visibleRelationRows } = await import("../app/branch-relations-ui-tools.mjs");
  const manyRefs = Array.from({ length: 45 }, (_, id) => ({ id: `refs/heads/topic-${id}`, name: `topic-${id}`, kind: "local" }));
  const selected = preferredReferenceId(manyRefs, null, null, manyRefs[40].id);
  const pairs = manyRefs.slice(0, 40).map((ref) => ({ left_ref_id: ref.id, right_ref_id: selected, relation: "equal", left_only: 0, right_only: 0, merge_bases: [] }));
  assert.equal(selected, manyRefs[40].id);
  assert.equal(selectReferencePairs(pairs, selected).length, 40);
  assert.equal(visibleRelationRows(selectReferencePairs(pairs, selected), 20).length, 20);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  connectionEventTime,
  edgeDisplayLabel,
  edgeReferenceIds,
  filterReferencePairs,
  orientPair,
  preferredReferenceId,
  referenceDisplayName,
  reasonLabel,
  selectReferencePairs,
  syncSelectedReferenceId,
} from "../app/branch-relations-tools.mjs";

const refs = [
  { id: "refs/heads/main", row_id: "main", name: "main", kind: "local", hash: "a".repeat(40) },
  { id: "refs/remotes/origin/main", row_id: "main", name: "origin/main", kind: "remote", hash: "a".repeat(40) },
  { id: "refs/heads/topic", row_id: "topic", name: "topic", kind: "local", hash: "b".repeat(40) },
];

test("relation focus keeps the exact local ref when multiple locals share a row", () => {
  const shared = [
    { ...refs[0], row_id: "shared" },
    { ...refs[2], row_id: "shared" },
  ];
  assert.equal(preferredReferenceId(shared, "shared", null, "refs/heads/topic"), "refs/heads/topic");
  assert.equal(preferredReferenceId(shared, "shared", null, "refs/heads/deleted"), null);
});

test("selected ref orientation preserves the backend ahead meaning", () => {
  const pair = {
    left_ref_id: "refs/heads/main",
    right_ref_id: "refs/heads/topic",
    relation: "ahead",
    left_only: 3,
    right_only: 0,
    merge_bases: ["base"],
    reason: null,
  };
  assert.deepEqual(orientPair(pair, "refs/heads/main"), {
    pair,
    selectedRefId: "refs/heads/main",
    otherRefId: "refs/heads/topic",
    relation: "ahead",
    selectedOnly: 3,
    otherOnly: 0,
    mergeBases: ["base"],
  });
  assert.equal(orientPair(pair, "refs/heads/topic").relation, "behind");
  assert.equal(orientPair(pair, "refs/heads/topic").selectedOnly, 0);
});

test("all unordered pairs for the selected ref remain available to filtering", () => {
  const pairs = [
    { left_ref_id: refs[0].id, right_ref_id: refs[2].id, relation: "diverged", left_only: 2, right_only: 1, merge_bases: [], reason: null },
    { left_ref_id: refs[1].id, right_ref_id: refs[2].id, relation: "unknown", left_only: null, right_only: null, merge_bases: null, reason: "shallow_history" },
  ];
  const selected = selectReferencePairs(pairs, refs[0].id);
  assert.equal(selected.length, 1);
  assert.equal(filterReferencePairs(selected, new Map(refs.map((ref) => [ref.id, ref])), "topic").length, 1);
  assert.equal(selectReferencePairs(pairs, refs[2].id).length, 2);
});

test("local and remote refs on one row are not collapsed when resolving an old edge", () => {
  const edge = { source_row_id: "main", target_row_id: "topic", source_ref_id: null, target_ref_id: null };
  assert.deepEqual(edgeReferenceIds(edge, refs), { source: null, target: null });
  assert.equal(edgeDisplayLabel(edge, refs), "操作元参照未取得 → 操作先参照未取得");
});

test("remote event labels retain the remote namespace", () => {
  const edge = { source_ref_id: refs[1].id, target_ref_id: refs[2].id };
  assert.equal(edgeDisplayLabel(edge, refs), "origin/main（リモート） → topic（ローカル）");
});

test("same-name remote refs remain distinguishable", () => {
  const origin = { id: "refs/remotes/origin/main", row_id: "origin-main", name: "main", kind: "remote", hash: null };
  const upstream = { id: "refs/remotes/upstream/main", row_id: "upstream-main", name: "main", kind: "remote", hash: null };
  assert.notEqual(referenceDisplayName(origin), referenceDisplayName(upstream));
  assert.equal(referenceDisplayName(origin), "origin/main");
  assert.equal(referenceDisplayName(upstream), "upstream/main");
});

test("historical PR labels remain visible when its source ref is gone", () => {
  const edge = { source_ref_id: null, target_ref_id: refs[0].id, source: "owner/repo:feature", target: "owner/repo:main" };
  assert.equal(edgeDisplayLabel(edge, refs), "owner/repo:feature → main（ローカル）");
});

test("operation time is preferred over commit timestamp for relation anchors", () => {
  const time = connectionEventTime({
    occurred_at: "2026-10-01T12:00:00Z",
    source_commit: { date: "2026-09-01T12:00:00Z" },
    target_commit: { date: "2026-09-02T12:00:00Z" },
  }, Date.parse("2026-10-02T00:00:00Z"));
  assert.equal(time, Date.parse("2026-10-01T12:00:00Z"));
});

test("a future operation is not replaced by an older commit timestamp", () => {
  const time = connectionEventTime({
    occurred_at: "2026-10-03T12:00:00Z",
    source_commit: { date: "2026-09-01T12:00:00Z" },
    target_commit: { date: "2026-09-02T12:00:00Z" },
  }, Date.parse("2026-10-02T00:00:00Z"));
  assert.equal(time, null);
});

test("an operation without an operation timestamp stays unavailable", () => {
  const time = connectionEventTime({
    operation: "merge",
    occurred_at: null,
    source_commit: { date: "2026-09-01T12:00:00Z" },
    target_commit: { date: "2026-09-02T12:00:00Z" },
  }, Date.parse("2026-10-02T00:00:00Z"));
  assert.equal(time, null);
});

test("preferred selection follows the user's local ref context", () => {
  assert.equal(preferredReferenceId(refs, "topic", "branch:topic"), "refs/heads/topic");
  assert.equal(preferredReferenceId(refs, "main", null), "refs/heads/main");
  assert.equal(preferredReferenceId(refs, null, "branch:topic"), "refs/heads/topic");
});

test("detached refs remain distinct by their recorded worktree identity", () => {
  const detached = { id: "detached:/tmp/worktree-a", name: "detached HEAD", kind: "detached", hash: null };
  assert.equal(referenceDisplayName(detached), "/tmp/worktree-a");
});

test("explicit lane changes follow the preferred local ref while refresh keeps manual selection", () => {
  const refsById = new Map(refs.map((ref) => [ref.id, ref]));
  assert.equal(syncSelectedReferenceId("refs/remotes/origin/main", "refs/heads/topic", true, refsById), "refs/heads/topic");
  assert.equal(syncSelectedReferenceId("refs/remotes/origin/main", "refs/heads/topic", false, refsById), "refs/remotes/origin/main");
  assert.equal(syncSelectedReferenceId("refs/heads/deleted", "refs/heads/topic", false, refsById), "refs/heads/topic");
});

test("unknown reasons are shown as Japanese explanations", () => {
  assert.equal(reasonLabel("shallow_history"), "履歴が浅く、祖先関係を確定できません。");
  assert.equal(reasonLabel("some_new_backend_reason"), "Gitの比較情報を取得できませんでした（理由コード: some_new_backend_reason）。");
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildContainmentCompareUrl,
  buildContainmentCsv,
  buildContainmentJson,
  buildContainmentRefMapping,
  buildContainmentRefMarkdown,
  containmentRefNavigation,
  containmentRemoteNamespace,
  containmentRemoteNamespaces,
  containmentRequestQuery,
  containmentSnapshotKey,
  defaultCommitContainment,
  filterContainmentRefs,
  filterContainmentRemoteRefs,
  groupContainmentRefs,
  isValidContainmentRevision,
  sortContainmentRefs,
} from "../app/commit-containment-tools.mjs";

const pinned = "a".repeat(40);
const target = "b".repeat(40);
const refs = [
  { ref: "refs/heads/main", type: "local", object_hash: pinned, peeled_commit: pinned },
  { ref: "refs/remotes/origin/main", type: "remote", object_hash: pinned, peeled_commit: pinned },
  { ref: "refs/tags/release", type: "tag", object_hash: "c".repeat(40), peeled_commit: target },
];
const snapshot = {
  revision: "HEAD",
  pinned_hash: pinned,
  observed_at: 123.5,
  truncated: true,
  record_limit: 1000,
  byte_limit: 4194304,
};

test("default containment state is explicit and does not invent a revision", () => {
  assert.deepEqual(defaultCommitContainment({ path: "/tmp/repo" }), {
    path: "/tmp/repo",
    revision: "",
    query: "",
    type: "all",
  });
  assert.throws(() => defaultCommitContainment({ path: "" }), TypeError);
});

test("revision validation accepts HEAD, refs, and complete hashes while rejecting expressions/options", () => {
  for (const value of ["HEAD", "main", "refs/heads/main", pinned]) assert.equal(isValidContainmentRevision(value), true);
  for (const value of ["", "--help", "HEAD~1", "main..feature", "refs/heads/main:README", "refs/heads/../main", "refs/heads/main lock"]) {
    assert.equal(isValidContainmentRevision(value), false);
  }
  assert.equal(containmentRequestQuery("/tmp/a repo", " HEAD "), "path=%2Ftmp%2Fa+repo&revision=HEAD");
  assert.throws(() => containmentRequestQuery("/tmp/repo", ""), TypeError);
});

test("name search and type selector operate only on the retrieved snapshot", () => {
  assert.deepEqual(filterContainmentRefs(refs, "main", "all").map((item) => item.ref), [
    "refs/heads/main",
    "refs/remotes/origin/main",
  ]);
  assert.deepEqual(filterContainmentRefs(refs, "main", "local").map((item) => item.ref), ["refs/heads/main"]);
  assert.deepEqual(filterContainmentRefs(refs, "release", "tag").map((item) => item.ref), ["refs/tags/release"]);
  assert.throws(() => filterContainmentRefs(refs, "", "LOCAL"), RangeError);
  assert.throws(() => filterContainmentRefs(refs, ""), TypeError);
});

test("compare URL places the immutable investigated commit in base and ref tip in target without execution", () => {
  const url = buildContainmentCompareUrl("/project?path=%2Ftmp%2Frepo&tab=info", pinned, target);
  const parsed = new URL(url, "http://localhost");
  assert.equal(parsed.searchParams.get("investigation"), "compare");
  assert.equal(parsed.searchParams.get("investigationBase"), pinned);
  assert.equal(parsed.searchParams.get("investigationTarget"), target);
  assert.equal(parsed.searchParams.get("investigationMode"), "direct");
  assert.equal(parsed.searchParams.get("path"), "/tmp/repo");
});

test("CSV exports only matching snapshot refs and protects formula-looking cells", () => {
  const formulaRef = { ref: "=HYPERLINK(\"https://example.test\")", type: "tag", object_hash: target, peeled_commit: pinned };
  const csv = buildContainmentCsv([formulaRef], { pinned_hash: pinned, observed_at: 123.5 });
  assert.match(csv, /^\uFEFF"pinned_hash","observed_at","ref","type","object_hash","peeled_commit"\r\n/);
  assert.match(csv, /"'=HYPERLINK/);
  assert.match(csv, /"123\.5"/);
  assert.ok(!csv.includes("refs/heads/main"));
  assert.equal(containmentSnapshotKey("/tmp/repo", { pinned_hash: pinned, observed_at: 123.5 }), `/tmp/repo\u0000${pinned}\u0000123.5`);
});

test("remote namespace filter matches one complete component and requires explicit null for all", () => {
  const remoteRefs = [
    ...refs,
    { ...refs[1], ref: "refs/remotes/origin2/main" },
    { ...refs[1], ref: "refs/remotes/upstream/topic/origin" },
    { ...refs[0], ref: "refs/heads/origin/topic" },
  ];
  assert.deepEqual(containmentRemoteNamespaces(remoteRefs), ["origin", "origin2", "upstream"]);
  assert.equal(containmentRemoteNamespace(refs[0]), null);
  assert.deepEqual(filterContainmentRemoteRefs(remoteRefs, "origin"), [refs[1]]);
  assert.deepEqual(filterContainmentRemoteRefs(remoteRefs, "missing"), []);
  assert.deepEqual(filterContainmentRemoteRefs(remoteRefs, null), remoteRefs);
  assert.throws(() => filterContainmentRemoteRefs(remoteRefs), TypeError);
  assert.throws(() => filterContainmentRemoteRefs(remoteRefs, ""), TypeError);
});

test("Git, name, and type ordering are deterministic and never mutate the observed snapshot", () => {
  const ordered = [
    { ...refs[2], ref: "refs/tags/a" },
    { ...refs[1], ref: "refs/remotes/origin/a" },
    { ...refs[0], ref: "refs/heads/z" },
    { ...refs[0], ref: "refs/heads/a" },
  ];
  const original = [...ordered];
  assert.deepEqual(sortContainmentRefs(ordered, "git"), original);
  assert.notEqual(sortContainmentRefs(ordered, "git"), ordered);
  assert.deepEqual(sortContainmentRefs(ordered, "name").map((item) => item.ref), [
    "refs/heads/a", "refs/tags/a", "refs/remotes/origin/a", "refs/heads/z",
  ]);
  assert.deepEqual(sortContainmentRefs(ordered, "type").map((item) => item.ref), [
    "refs/heads/a", "refs/heads/z", "refs/remotes/origin/a", "refs/tags/a",
  ]);
  assert.deepEqual(ordered, original);
  assert.throws(() => sortContainmentRefs(ordered, "unknown"), RangeError);
  assert.throws(() => sortContainmentRefs(ordered), RangeError);
});

test("grouping uses peeled targets, preserves first-target order, and retains every ref object", () => {
  const annotated = { ...refs[2], ref: "refs/tags/same-target", peeled_commit: pinned.toUpperCase() };
  const observed = [refs[0], refs[2], refs[1], annotated];
  const groups = groupContainmentRefs(observed);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].peeled_commit, pinned);
  assert.deepEqual(groups[0].refs, [refs[0], refs[1], annotated]);
  assert.deepEqual(groups[1].refs, [refs[2]]);
  assert.equal(groups[0].refs[2].object_hash, "c".repeat(40));
  assert.deepEqual(observed, [refs[0], refs[2], refs[1], annotated]);
});

test("visible ref navigation respects list order, endpoints, and excluded selection", () => {
  assert.deepEqual(containmentRefNavigation(refs, refs[1].ref), {
    position: 2, total: 3, previous: refs[0].ref, next: refs[2].ref, first: refs[0].ref,
  });
  assert.equal(containmentRefNavigation(refs, refs[0].ref).previous, null);
  assert.equal(containmentRefNavigation(refs, refs[2].ref).next, null);
  assert.deepEqual(containmentRefNavigation([refs[2]], refs[0].ref), {
    position: null, total: 1, previous: null, next: null, first: refs[2].ref,
  });
  assert.deepEqual(containmentRefNavigation([], null), {
    position: null, total: 0, previous: null, next: null, first: null,
  });
  assert.throws(() => containmentRefNavigation(refs), TypeError);
});

test("JSON export retains selected view conditions, full hashes, and original snapshot truncation", () => {
  const view = { path: "/tmp/repo", query: "main", type: "remote", remote: "origin", order: "type", grouped: true };
  const result = JSON.parse(buildContainmentJson([refs[1]], snapshot, view));
  assert.deepEqual(result, {
    schema_version: 1,
    path: "/tmp/repo",
    ...snapshot,
    filters: { query: "main", type: "remote", remote: "origin" },
    order: "type",
    grouped: true,
    refs: [refs[1]],
  });
  assert.equal(result.refs[0].peeled_commit.length, 40);
  assert.deepEqual(JSON.parse(buildContainmentJson([], snapshot, { ...view, remote: null })).refs, []);
  assert.throws(() => buildContainmentJson(refs, snapshot, { ...view, remote: undefined }), TypeError);
  assert.throws(() => buildContainmentJson(refs, { pinned_hash: pinned }, view), TypeError);
});

test("selected-ref Markdown carries pinned evidence, UTC time, and annotated tag identity", () => {
  const report = buildContainmentRefMarkdown("/tmp/a`repo", refs[2], snapshot);
  assert.match(report, /リポジトリ: ``\/tmp\/a`repo``/u);
  assert.ok(report.includes(`調査revision: \`HEAD\``));
  assert.ok(report.includes(`固定コミット: \`${pinned}\``));
  assert.ok(report.includes("1970-01-01T00:02:03.500Z"));
  assert.ok(report.includes("上限に達したため一部の参照のみ"));
  assert.ok(report.includes(`参照: \`refs/tags/release\``));
  assert.ok(report.includes(`ref object: \`${"c".repeat(40)}\``));
  assert.ok(report.includes(`固定先コミット: \`${target}\``));
  assert.ok(!report.includes("refs/heads/main"));
});

test("displayed ref mapping uses complete names and peeled commit hashes without hidden refs", () => {
  const mapping = buildContainmentRefMapping([refs[2], refs[1]]);
  assert.deepEqual(JSON.parse(mapping), {
    "refs/tags/release": target,
    "refs/remotes/origin/main": pinned,
  });
  assert.ok(mapping.indexOf("refs/tags/release") < mapping.indexOf("refs/remotes/origin/main"));
  assert.ok(!mapping.includes("refs/heads/main"));
  assert.ok(!mapping.includes("c".repeat(40)));
  assert.equal(buildContainmentRefMapping([]), "{}\n");
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildContainmentCompareUrl,
  buildContainmentCsv,
  containmentRequestQuery,
  containmentSnapshotKey,
  defaultCommitContainment,
  filterContainmentRefs,
  isValidContainmentRevision,
} from "../app/commit-containment-tools.mjs";

const pinned = "a".repeat(40);
const target = "b".repeat(40);
const refs = [
  { ref: "refs/heads/main", type: "local", object_hash: pinned, peeled_commit: pinned },
  { ref: "refs/remotes/origin/main", type: "remote", object_hash: pinned, peeled_commit: pinned },
  { ref: "refs/tags/release", type: "tag", object_hash: "c".repeat(40), peeled_commit: target },
];

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

import test from "node:test";
import assert from "node:assert/strict";
import {
  optionalWholeNumber,
  workbookEntries,
  workbookExtensions,
  workbookDuplicates,
  workbookCoverage,
  workbookDelta,
  workbookMarkdown,
} from "../app/tree-size-workbook-tools.mjs";
const a = {
  path: "src/a.TXT",
  mode: "100755",
  type: "blob",
  hash: "a".repeat(40),
  size: 10,
};
const b = { ...a, path: "copy.txt", mode: "100644" };
const c = {
  path: "nested/deep/sub",
  mode: "160000",
  type: "commit",
  hash: "c".repeat(40),
  size: null,
};
const all = [a, b, c];
const filters = {
  exclude: "",
  mode: null,
  hash: "",
  depth: null,
  extension: null,
  hideReviewed: false,
};
test("strict optional integers retain zero and reject exponent/negative/unsafe", () => {
  assert.deepEqual(optionalWholeNumber(""), { value: null, error: null });
  assert.equal(optionalWholeNumber("0").value, 0);
  for (const raw of ["-1", "1e2", " 2", "9007199254740992"])
    assert.ok(optionalWholeNumber(raw).error);
});
test("workbook independent filters intersect without changing source", () => {
  assert.deepEqual(
    workbookEntries(all, { ...filters, exclude: "SRC/" }, new Set()),
    [b, c],
  );
  assert.deepEqual(
    workbookEntries(all, { ...filters, mode: "100755" }, new Set()),
    [a],
  );
  assert.deepEqual(
    workbookEntries(all, { ...filters, hash: a.hash.toUpperCase() }, new Set()),
    [a, b],
  );
  assert.deepEqual(workbookEntries(all, { ...filters, depth: 0 }, new Set()), [
    b,
  ]);
  assert.deepEqual(
    workbookEntries(
      all,
      { ...filters, extension: ".txt", hideReviewed: true },
      new Set([a.path]),
    ),
    [b],
  );
  assert.equal(all.length, 3);
});
test("extension aggregates preserve unknown and extensionless names", () => {
  assert.deepEqual(workbookExtensions(all), [
    { extension: ".txt", count: 2, bytes: 20, unknown: 0 },
    { extension: "", count: 1, bytes: 0, unknown: 1 },
  ]);
});
test("duplicate groups use type+hash and expose every path", () => {
  assert.deepEqual(
    workbookDuplicates([
      ...all,
      { ...a, path: "same-hash-other-type", type: "commit" },
    ]),
    [[a, b]],
  );
});
test("coverage ranks known entries and reports unknown denominator separately", () => {
  assert.deepEqual(workbookCoverage(all, 1), {
    largest: [b],
    bytes: 10,
    total: 20,
    percent: 50,
    unknown: 1,
  });
  assert.equal(workbookCoverage([c], 10).percent, null);
  assert.equal(workbookCoverage(all, 0).bytes, 0);
});
test("comparison detects mode-only changes, additions, removals and unknown deltas", () => {
  const changes = workbookDelta(
    [a, c],
    [
      { ...a, mode: "100644" },
      { ...b, path: "new" },
    ],
  );
  assert.equal(changes.find((e) => e.path === a.path).delta, 0);
  assert.equal(changes.find((e) => e.path === c.path).delta, null);
  assert.equal(changes.find((e) => e.path === "new").delta, 10);
  assert.deepEqual(workbookDelta(all, all), []);
});
test("Markdown includes immutable identity, conditions, partial coverage and exact paths", () => {
  const s = workbookMarkdown(
    "/repo",
    { revision: "main", pinned_hash: a.hash, truncated: true },
    all,
    { exclude: "x" },
  );
  assert.ok(s.includes(a.hash));
  assert.ok(s.includes("あり（部分集計）"));
  assert.ok(s.includes("不明: 1"));
  assert.ok(s.includes('"exclude": "x"'));
  assert.ok(s.includes("src/a.TXT"));
});

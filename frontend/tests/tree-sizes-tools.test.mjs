import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateTreeSizeDirectories,
  formatTreeSizeBytes,
  minimumTreeSizeError,
  parseMinimumTreeSize,
  sortTreeSizeEntries,
  treeSizeKind,
  treeSizesCsv,
  treeSizesQuery,
} from "../app/tree-sizes-tools.mjs";

const entries = [
  { path: "src/large.bin", mode: "100644", type: "blob", hash: "a".repeat(40), size: 8192 },
  { path: "src/small.txt", mode: "100644", type: "blob", hash: "b".repeat(40), size: 6 },
  { path: "docs/copy.txt", mode: "100644", type: "blob", hash: "b".repeat(40), size: 6 },
  { path: "external-link", mode: "120000", type: "blob", hash: "c".repeat(40), size: 29 },
  { path: "vendor", mode: "160000", type: "commit", hash: "d".repeat(40), size: null },
  { path: "=formula.txt", mode: "100644", type: "blob", hash: "e".repeat(40), size: 3 },
];

test("tree-size request keeps repository and revision explicit", () => {
  assert.equal(treeSizesQuery("/repo", "HEAD"), "path=%2Frepo&revision=HEAD");
  assert.throws(() => treeSizesQuery("/repo"), /revision/);
});

test("tree-size kinds preserve symlink and gitlink semantics", () => {
  assert.equal(treeSizeKind(entries[0]), "regular");
  assert.equal(treeSizeKind(entries[3]), "symlink");
  assert.equal(treeSizeKind(entries[4]), "gitlink");
});

test("directory aggregates include descendants and retain unknown counts", () => {
  assert.deepEqual(aggregateTreeSizeDirectories(entries, "").map((item) => [item.path, item.totalBytes, item.fileCount, item.unknownSizeCount]), [
    ["docs", 6, 1, 0],
    ["src", 8198, 2, 0],
  ]);
  assert.deepEqual(aggregateTreeSizeDirectories(entries, "src"), []);
  assert.deepEqual(aggregateTreeSizeDirectories([...entries, { path: "vendor/lib/file", mode: "100644", type: "blob", hash: "f".repeat(40), size: 4 }], ""), [
    { path: "docs", totalBytes: 6, fileCount: 1, unknownSizeCount: 0 },
    { path: "src", totalBytes: 8198, fileCount: 2, unknownSizeCount: 0 },
    { path: "vendor", totalBytes: 4, fileCount: 1, unknownSizeCount: 0 },
  ]);
});

test("minimum size validation never guesses an invalid value", () => {
  assert.equal(parseMinimumTreeSize(""), null);
  assert.equal(parseMinimumTreeSize("6"), 6);
  assert.equal(parseMinimumTreeSize("0"), null);
  assert.equal(parseMinimumTreeSize("6.5"), null);
  assert.equal(minimumTreeSizeError(""), null);
  assert.equal(minimumTreeSizeError("0"), "最小サイズは1以上の安全な整数バイトで指定してください。");
  assert.match(minimumTreeSizeError("six"), /正の整数/);
});

test("size formatting includes exact bytes and binary unit", () => {
  assert.equal(formatTreeSizeBytes(6), "6 B");
  assert.equal(formatTreeSizeBytes(1536), "1,536 B (1.50 KiB)");
  assert.equal(formatTreeSizeBytes(null), "サイズ未取得");
});

test("sorting supports both directions while keeping unknown sizes last", () => {
  assert.deepEqual(sortTreeSizeEntries(entries, "size", "descending").map((entry) => entry.path), [
    "src/large.bin", "external-link", "docs/copy.txt", "src/small.txt", "=formula.txt", "vendor",
  ]);
  assert.equal(sortTreeSizeEntries(entries, "size", "ascending").at(-1).path, "vendor");
});

test("CSV has a BOM, filtered rows only, and formula-safe space prefix", () => {
  const csv = treeSizesCsv([entries[5], entries[4]]);
  assert.ok(csv.startsWith("\ufeff"));
  assert.match(csv, / \=formula\.txt/);
  assert.match(csv, /vendor/);
  assert.equal(csv.split("\r\n").length, 4);
});

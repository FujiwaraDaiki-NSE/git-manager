import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateTreeSizeDirectories,
  aggregateTreeSizeObjectSummary,
  duplicateTreeSizeEntries,
  filterTreeSizeEntries,
  formatTreeSizeBytes,
  listTreeSizeExtensions,
  maximumTreeSizeError,
  minimumTreeSizeError,
  parseMaximumTreeSize,
  parseMinimumTreeSize,
  sortTreeSizeEntries,
  treeSizeExtension,
  treeSizeKind,
  treeSizeRangeError,
  treeSizesJson,
  treeSizesPathLines,
  treeSizesCsv,
  treeSizesQuery,
  TREE_SIZE_EXTENSION_ALL,
  TREE_SIZE_EXTENSION_NONE,
  TREE_SIZE_FILTER_ALL,
  TREE_SIZE_FILTER_KNOWN,
  TREE_SIZE_FILTER_UNKNOWN,
} from "../app/tree-sizes-tools.mjs";

const entries = [
  { path: "src/large.bin", mode: "100644", type: "blob", hash: "a".repeat(40), size: 8192 },
  { path: "src/small.txt", mode: "100644", type: "blob", hash: "b".repeat(40), size: 6 },
  { path: "docs/copy.txt", mode: "100644", type: "blob", hash: "b".repeat(40), size: 6 },
  { path: ".hidden", mode: "100644", type: "blob", hash: "f".repeat(40), size: 0 },
  { path: "trailing.", mode: "100644", type: "blob", hash: "g".repeat(40), size: 0 },
  { path: "line\nfile.txt", mode: "100644", type: "blob", hash: "h".repeat(40), size: 4 },
  { path: "src/.env.local", mode: "100644", type: "blob", hash: "i".repeat(40), size: 12 },
  { path: "external-link", mode: "120000", type: "blob", hash: "c".repeat(40), size: 29 },
  { path: "vendor", mode: "160000", type: "commit", hash: "d".repeat(40), size: null },
  { path: "=formula.txt", mode: "100644", type: "blob", hash: "e".repeat(40), size: 3 },
];

const noFilters = {
  directory: "",
  pathQuery: "",
  kind: "all",
  minimumBytes: null,
  maximumBytes: null,
  sizeFilter: TREE_SIZE_FILTER_ALL,
  extension: TREE_SIZE_EXTENSION_ALL,
  duplicateOnly: false,
};

test("tree-size request keeps repository and revision explicit", () => {
  assert.equal(treeSizesQuery("/repo", "HEAD"), "path=%2Frepo&revision=HEAD");
  assert.throws(() => treeSizesQuery("/repo"), /revision/);
});

test("tree-size kinds preserve symlink and gitlink semantics", () => {
  assert.equal(treeSizeKind(entries[0]), "regular");
  assert.equal(treeSizeKind(entries[7]), "symlink");
  assert.equal(treeSizeKind(entries[8]), "gitlink");
});

test("directory aggregates include descendants and retain unknown counts", () => {
  assert.deepEqual(aggregateTreeSizeDirectories(entries, "").map((item) => [item.path, item.totalBytes, item.fileCount, item.unknownSizeCount]), [
    ["docs", 6, 1, 0],
    ["src", 8210, 3, 0],
  ]);
  assert.deepEqual(aggregateTreeSizeDirectories(entries, "src"), []);
  assert.deepEqual(aggregateTreeSizeDirectories([...entries, { path: "vendor/lib/file", mode: "100644", type: "blob", hash: "f".repeat(40), size: 4 }], ""), [
    { path: "docs", totalBytes: 6, fileCount: 1, unknownSizeCount: 0 },
    { path: "src", totalBytes: 8210, fileCount: 3, unknownSizeCount: 0 },
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

test("maximum size keeps zero explicit and rejects unknown or invalid values", () => {
  assert.equal(parseMaximumTreeSize(""), null);
  assert.equal(parseMaximumTreeSize("0"), 0);
  assert.equal(parseMaximumTreeSize("6"), 6);
  assert.equal(parseMaximumTreeSize("6.5"), null);
  assert.equal(maximumTreeSizeError(""), null);
  assert.equal(maximumTreeSizeError("0"), null);
  assert.match(maximumTreeSizeError("six"), /0以上/);
  const zero = filterTreeSizeEntries(entries, { ...noFilters, maximumBytes: 0 });
  assert.deepEqual(zero.map((entry) => entry.path), [".hidden", "trailing."]);
  assert.deepEqual(filterTreeSizeEntries(entries, { ...noFilters, sizeFilter: TREE_SIZE_FILTER_UNKNOWN }).map((entry) => entry.path), ["vendor"]);
  assert.deepEqual(filterTreeSizeEntries(entries, { ...noFilters, sizeFilter: TREE_SIZE_FILTER_KNOWN }).map((entry) => entry.path), entries.filter((entry) => entry.size !== null).map((entry) => entry.path));
  assert.deepEqual(filterTreeSizeEntries(entries, { ...noFilters, maximumBytes: 0, sizeFilter: TREE_SIZE_FILTER_UNKNOWN }), []);
  assert.throws(() => filterTreeSizeEntries(entries, { ...noFilters, maximumBytes: undefined }), TypeError);
});

test("reversed minimum and maximum sizes are an explicit condition error", () => {
  assert.equal(treeSizeRangeError(null, null), null);
  assert.equal(treeSizeRangeError(20, 20), null);
  assert.equal(treeSizeRangeError(20, null), null);
  assert.equal(treeSizeRangeError(null, 10), null);
  assert.equal(treeSizeRangeError(20, 10), "最小サイズは最大サイズ以下で指定してください。");
  assert.throws(() => treeSizeRangeError(undefined, 10), TypeError);
});

test("extension filtering distinguishes extensionless names and dotfiles", () => {
  assert.equal(treeSizeExtension("README"), null);
  assert.equal(treeSizeExtension(".gitignore"), null);
  assert.equal(treeSizeExtension(".env.local"), ".local");
  assert.equal(treeSizeExtension("trailing."), null);
  assert.deepEqual(listTreeSizeExtensions(entries), [TREE_SIZE_EXTENSION_NONE, ".bin", ".local", ".txt"]);
  assert.deepEqual(filterTreeSizeEntries(entries, { ...noFilters, extension: TREE_SIZE_EXTENSION_NONE }).map((entry) => entry.path), [".hidden", "trailing.", "external-link", "vendor"]);
  assert.deepEqual(filterTreeSizeEntries(entries, { ...noFilters, extension: ".LOCAL" }).map((entry) => entry.path), ["src/.env.local"]);
  assert.throws(() => filterTreeSizeEntries(entries, { ...noFilters, extension: "txt" }), RangeError);
});

test("duplicate filtering uses only exact type and hash, without capacity claims", () => {
  const differentType = { path: "commit-like", mode: "160000", type: "commit", hash: "b".repeat(40), size: null };
  const source = [...entries, differentType];
  assert.deepEqual(duplicateTreeSizeEntries(source).map((entry) => entry.path), ["src/small.txt", "docs/copy.txt"]);
  assert.deepEqual(filterTreeSizeEntries(source, { ...noFilters, duplicateOnly: true }).map((entry) => entry.path), ["src/small.txt", "docs/copy.txt"]);
});

test("object summary compares visible path and distinct object totals while retaining unknowns", () => {
  const summary = aggregateTreeSizeObjectSummary(entries);
  assert.equal(summary.pathFileCount, entries.length);
  assert.equal(summary.pathUnknownSizeCount, 1);
  assert.equal(summary.objectCount, entries.length - 1);
  assert.equal(summary.duplicateReferenceCount, 1);
  assert.equal(summary.pathTotalBytes, entries.reduce((total, entry) => total + (entry.size ?? 0), 0));
  assert.equal(summary.objectTotalBytes, summary.pathTotalBytes - 6);
  assert.equal(summary.objectUnknownSizeCount, 1);
  assert.equal(summary.objects.find((object) => object.hash === "d".repeat(40)).size, null);
  assert.deepEqual(summary.objects.find((object) => object.hash === "b".repeat(40)).paths, ["src/small.txt", "docs/copy.txt"]);
});

test("JSON export carries fixed hash, coverage, local conditions, and visible rows only", () => {
  const snapshot = {
    revision: "HEAD",
    pinned_hash: "1".repeat(40),
    file_count: entries.length,
    unknown_size_count: 1,
    truncated: true,
    limit: 10000,
    byte_limit: 4096,
  };
  const conditions = { ...noFilters, maximumBytes: 0, sizeFilter: TREE_SIZE_FILTER_KNOWN, extension: TREE_SIZE_EXTENSION_NONE, duplicateOnly: true, order: "size", direction: "descending" };
  const parsed = JSON.parse(treeSizesJson([entries[1], entries[2]], snapshot, conditions, "/repo-a"));
  assert.equal(parsed.format, "gitdash-tree-sizes-v1");
  assert.equal(parsed.repository_path, "/repo-a");
  assert.equal(parsed.pinned_hash, snapshot.pinned_hash);
  assert.deepEqual(parsed.coverage, {
    retrieved_path_count: entries.length,
    visible_path_count: 2,
    retrieved_unknown_size_count: 1,
    visible_unknown_size_count: 0,
    truncated: true,
    entry_limit: 10000,
    byte_limit: 4096,
  });
  assert.deepEqual(parsed.conditions, conditions);
  assert.deepEqual(parsed.entries.map((entry) => entry.path), ["src/small.txt", "docs/copy.txt"]);
  assert.throws(() => treeSizesJson([], { ...snapshot, pinned_hash: "short" }, conditions, "/repo-a"), TypeError);
  assert.throws(() => treeSizesJson([], snapshot, conditions), TypeError);
});

test("path line copy is JSON escaped and keeps visible order", () => {
  assert.equal(treeSizesPathLines([entries[5], entries[2], entries[3]]), '"line\\nfile.txt"\n"docs/copy.txt"\n".hidden"');
  assert.equal(treeSizesPathLines([]), "");
});

test("size formatting includes exact bytes and binary unit", () => {
  assert.equal(formatTreeSizeBytes(6), "6 B");
  assert.equal(formatTreeSizeBytes(1536), "1,536 B (1.50 KiB)");
  assert.equal(formatTreeSizeBytes(null), "サイズ未取得");
});

test("sorting supports both directions while keeping unknown sizes last", () => {
  assert.deepEqual(sortTreeSizeEntries(entries, "size", "descending").map((entry) => entry.path), [
    "src/large.bin", "external-link", "src/.env.local", "docs/copy.txt", "src/small.txt", "line\nfile.txt", "=formula.txt", ".hidden", "trailing.", "vendor",
  ]);
  assert.equal(sortTreeSizeEntries(entries, "size", "ascending").at(-1).path, "vendor");
});

test("CSV has a BOM, filtered rows only, and formula-safe space prefix", () => {
  const csv = treeSizesCsv([entries[9], entries[8]]);
  assert.ok(csv.startsWith("\ufeff"));
  assert.match(csv, / \=formula\.txt/);
  assert.match(csv, /vendor/);
  assert.equal(csv.split("\r\n").length, 4);
});

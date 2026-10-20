import assert from "node:assert/strict";
import test from "node:test";
import {
  IGNORE_DIRECTORY_ROOT,
  IGNORE_PATH_LIMIT,
  checkIgnorePayload,
  filterIgnoreEntriesByDirectory,
  ignoreEntriesCsv,
  ignoreEntryDirectory,
  ignoreEntryStatus,
  listIgnoreDirectories,
  parseIgnoreCandidates,
  searchIgnoreEntries,
  sortIgnoreEntries,
} from "../app/ignore-inspector-tools.mjs";

const entries = [
  { path: "src/zeta.log", ignored: true, tracked: false, source: ".gitignore", line: 2, pattern: "*.log", negation: false },
  { path: "README", ignored: false, tracked: false, source: null, line: null, pattern: null, negation: null },
  { path: "src/keep.log", ignored: false, tracked: true, source: ".gitignore", line: 3, pattern: "!keep.log", negation: true },
  { path: "docs/read me.txt", ignored: true, tracked: false, source: "docs/.gitignore", line: 1, pattern: "*.txt", negation: false },
];

test("directory and search filters preserve exact paths", () => {
  assert.equal(ignoreEntryDirectory("README"), IGNORE_DIRECTORY_ROOT);
  assert.deepEqual(listIgnoreDirectories(entries), [".", "docs", "src"]);
  assert.deepEqual(filterIgnoreEntriesByDirectory(entries, "src").map((entry) => entry.path), ["src/zeta.log", "src/keep.log"]);
  assert.deepEqual(searchIgnoreEntries(entries, "KEEP").map((entry) => entry.path), ["src/keep.log"]);
  assert.deepEqual(filterIgnoreEntriesByDirectory(entries, "/"), entries);
});

test("sorting is stable for source data and supports both directions", () => {
  assert.deepEqual(sortIgnoreEntries(entries, "asc").map((entry) => entry.path), ["docs/read me.txt", "README", "src/keep.log", "src/zeta.log"]);
  assert.deepEqual(sortIgnoreEntries(entries, "desc").map((entry) => entry.path), ["src/zeta.log", "src/keep.log", "README", "docs/read me.txt"]);
  assert.equal(entries[0].path, "src/zeta.log");
});

test("candidate parser keeps spaces and rejects unsafe repository paths", () => {
  assert.deepEqual(parseIgnoreCandidates(" leading\nline\nname.txt\n\n"), [" leading", "line", "name.txt"]);
  assert.throws(() => parseIgnoreCandidates("../outside"), /parent traversal/);
  assert.throws(() => parseIgnoreCandidates("/outside"), /repository-relative/);
  assert.throws(() => parseIgnoreCandidates("a\0b"), /NUL/);
  assert.throws(() => parseIgnoreCandidates(Array.from({ length: IGNORE_PATH_LIMIT + 1 }, (_, index) => `path-${index}`).join("\n")), /件以下/);
});

test("payload validates exact candidate rows and CSV protects formula prefixes", () => {
  assert.deepEqual(checkIgnorePayload("/repo", ["src/file.txt"]), { path: "/repo", paths: ["src/file.txt"] });
  assert.throws(() => checkIgnorePayload("/repo", []), /件/);
  const csv = ignoreEntriesCsv([
    { path: "=HYPERLINK(\"x\")", ignored: true, tracked: false, source: ".gitignore", line: 1, pattern: "*.log", negation: false },
    { path: "+danger", ignored: false, tracked: true, source: null, line: null, pattern: null, negation: true },
  ]);
  assert.equal(csv, '\uFEFF"path","ignored","tracked","source","line","pattern","negation"\r\n"\'=HYPERLINK(""x"")","true","false",".gitignore","1","*.log","false"\r\n"\'+danger","false","true","","","","true"\r\n');
});

test("status text distinguishes tracked rules and negative rules", () => {
  assert.equal(ignoreEntryStatus(entries[0]), "無視される");
  assert.equal(ignoreEntryStatus(entries[2]), "無視しない（否定ルール）");
  assert.equal(ignoreEntryStatus({ ...entries[0], tracked: true }), "無視ルールあり・追跡済み");
  assert.equal(ignoreEntryStatus(entries[1]), "無視ルールなし");
});

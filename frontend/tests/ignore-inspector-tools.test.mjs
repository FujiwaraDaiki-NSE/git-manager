import assert from "node:assert/strict";
import test from "node:test";
import {
  IGNORE_DIRECTORY_ROOT,
  IGNORE_PATH_LIMIT,
  checkIgnorePayload,
  deduplicateIgnoreCandidates,
  filterIgnoreEntriesByDirectory,
  filterIgnoreEntriesByOutcome,
  filterIgnoreEntriesByRule,
  filterIgnoreEntriesBySource,
  ignoreCandidatesMatchResult,
  ignoreEntriesCandidateText,
  ignoreEntriesCsv,
  ignoreEntriesReport,
  ignoreEntryDirectory,
  ignoreEntryStatus,
  ignoreRuleKey,
  inspectIgnoreCandidates,
  listIgnoreDirectories,
  listIgnoreSources,
  paginateIgnoreEntries,
  parseIgnoreCandidates,
  searchIgnoreEntries,
  sortIgnoreEntries,
  summarizeIgnoreOutcomes,
  summarizeIgnoreRules,
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

test("source counts and exact filtering distinguish null metadata from a file named null", () => {
  const rows = [...entries, { ...entries[0], path: "other.log", source: "null" }];
  assert.deepEqual(listIgnoreSources(rows), [
    { source: ".gitignore", count: 2 },
    { source: "docs/.gitignore", count: 1 },
    { source: "null", count: 1 },
    { source: null, count: 1 },
  ]);
  assert.deepEqual(filterIgnoreEntriesBySource(rows, null).map((entry) => entry.path), ["README"]);
  assert.deepEqual(filterIgnoreEntriesBySource(rows, "null").map((entry) => entry.path), ["other.log"]);
  assert.deepEqual(filterIgnoreEntriesBySource(rows, ".gitignore").map((entry) => entry.path), ["src/zeta.log", "src/keep.log"]);
  assert.throws(() => filterIgnoreEntriesBySource(rows, undefined), /string or null/);
});

test("rule impact counts use source, line, pattern and negation together", () => {
  const rows = [
    entries[0],
    { ...entries[0], path: "same.log" },
    { ...entries[0], path: "nested.log", source: "src/.gitignore" },
    { ...entries[0], path: "later.log", line: 8 },
    { ...entries[0], path: "literal.log", negation: true },
    entries[1],
  ];
  const groups = summarizeIgnoreRules(rows);
  assert.equal(groups.length, 5);
  assert.equal(groups[0].count, 2);
  assert.deepEqual(filterIgnoreEntriesByRule(rows, groups[0].key).map((entry) => entry.path), ["src/zeta.log", "same.log"]);
  assert.notEqual(ignoreRuleKey(rows[0]), ignoreRuleKey(rows[2]));
  assert.notEqual(ignoreRuleKey(rows[0]), ignoreRuleKey(rows[3]));
  assert.notEqual(ignoreRuleKey(rows[0]), ignoreRuleKey(rows[4]));
  assert.throws(() => filterIgnoreEntriesByRule(rows, ""), /required/);
  assert.equal(rows[0].path, "src/zeta.log");
});

test("inventory pagination bounds the final page and refuses invalid page parameters", () => {
  const rows = Array.from({ length: 61 }, (_, index) => ({ ...entries[0], path: "file-" + index }));
  const page = paginateIgnoreEntries(rows, 3, 25);
  assert.equal(page.pageCount, 3);
  assert.equal(page.start, 51);
  assert.equal(page.end, 61);
  assert.equal(page.total, 61);
  assert.deepEqual(page.entries.map((entry) => entry.path), rows.slice(50).map((entry) => entry.path));
  assert.deepEqual(paginateIgnoreEntries([], 1, 50), { entries: [], page: 1, pageCount: 1, start: 0, end: 0, total: 0 });
  assert.throws(() => paginateIgnoreEntries(rows, 0, 25), /outside/);
  assert.throws(() => paginateIgnoreEntries(rows, 4, 25), /outside/);
  assert.throws(() => paginateIgnoreEntries(rows, 1.5, 25), /outside/);
  assert.throws(() => paginateIgnoreEntries(rows, 1, 10), /page size/);
  assert.throws(() => paginateIgnoreEntries(rows, 1), /page size/);
});

test("outcome filters partition ignored, tracked matches, negations and unmatched paths", () => {
  const rows = [...entries, { ...entries[0], path: "tracked.log", tracked: true }];
  assert.deepEqual(summarizeIgnoreOutcomes(rows), { all: 5, ignored: 2, tracked: 1, negation: 1, unmatched: 1 });
  assert.deepEqual(filterIgnoreEntriesByOutcome(rows, "ignored").map((entry) => entry.path), ["src/zeta.log", "docs/read me.txt"]);
  assert.deepEqual(filterIgnoreEntriesByOutcome(rows, "tracked").map((entry) => entry.path), ["tracked.log"]);
  assert.deepEqual(filterIgnoreEntriesByOutcome(rows, "negation").map((entry) => entry.path), ["src/keep.log"]);
  assert.deepEqual(filterIgnoreEntriesByOutcome(rows, "unmatched").map((entry) => entry.path), ["README"]);
  assert.deepEqual(filterIgnoreEntriesByOutcome(rows, "all"), rows);
  assert.throws(() => filterIgnoreEntriesByOutcome(rows, "unknown"), /Unknown/);
});

test("candidate validation and explicit deduplication preserve exact spelling and spaces", () => {
  const value = " src/file.txt\r\nsrc/file.txt\n src/file.txt\n\nsrc/file.txt ";
  assert.deepEqual(inspectIgnoreCandidates(value), { count: 4, uniqueCount: 3, duplicateCount: 1, error: null });
  assert.equal(deduplicateIgnoreCandidates(value), " src/file.txt\nsrc/file.txt\nsrc/file.txt ");
  const tooMany = Array.from({ length: 101 }, () => "same.log").join("\n");
  assert.match(inspectIgnoreCandidates(tooMany).error, /件以下/);
  assert.equal(inspectIgnoreCandidates(deduplicateIgnoreCandidates(tooMany)).error, null);
  assert.match(inspectIgnoreCandidates("../outside").error, /parent traversal/);
  assert.match(inspectIgnoreCandidates("").error, /1件以上/);
});

test("candidate/result correspondence ignores blank lines but detects order, spaces and invalid edits", () => {
  const submitted = ["a.log", " b.log"];
  assert.equal(ignoreCandidatesMatchResult("\na.log\r\n\n b.log\n", submitted), true);
  assert.equal(ignoreCandidatesMatchResult(" b.log\na.log", submitted), false);
  assert.equal(ignoreCandidatesMatchResult("a.log\nb.log", submitted), false);
  assert.equal(ignoreCandidatesMatchResult("a.log\n b.log\n../outside", submitted), false);
  assert.equal(ignoreCandidatesMatchResult("", submitted), false);
});

test("selection transfer keeps exact paths and refuses unrepresentable or excessive selections", () => {
  assert.equal(ignoreEntriesCandidateText([entries[3], entries[0]]), "docs/read me.txt\nsrc/zeta.log");
  assert.throws(() => ignoreEntriesCandidateText([]), /1〜/);
  assert.throws(() => ignoreEntriesCandidateText([{ ...entries[0], path: "line\nbreak.log" }]), /改行/);
  assert.throws(() => ignoreEntriesCandidateText([{ ...entries[0], path: "line\rbreak.log" }]), /改行/);
  assert.throws(() => ignoreEntriesCandidateText(Array.from({ length: 101 }, () => entries[0])), /1〜/);
});

test("copied reports carry scope, filter and snapshot caveats with escaped rule evidence", () => {
  const context = {
    repository: "/repos/project",
    scope: "選択した候補",
    filters: ["ルール元: .gitignore", "判定: 無視される"],
    inventoryTruncated: true,
    inputCurrent: false,
  };
  const report = ignoreEntriesReport([{ ...entries[0], path: "a|[b]\n<script>.log", pattern: "*.log|cache/" }], context);
  assert.match(report, /リポジトリ: \/repos\/project/);
  assert.match(report, /対象: 選択した候補 \/ 1件/);
  assert.match(report, /条件: ルール元: \.gitignore/);
  assert.match(report, /取得上限に達した一部/);
  assert.match(report, /前回送信したパスの結果/);
  assert.ok(report.includes("a\\|\\[b\\]\\n&lt;script&gt;.log"));
  assert.ok(report.includes("\\*.log\\|cache/"));
  assert.ok(!report.includes("<script>"));
  assert.throws(() => ignoreEntriesReport(entries, { repository: "/repo", scope: "rows", filters: [] }), /context/);
  const currentReport = ignoreEntriesReport(entries, { ...context, inventoryTruncated: false, inputCurrent: true });
  assert.match(currentReport, /判定に送信したパスと一致/);
  assert.match(currentReport, /取得時点の無視済みファイル一覧/);
});

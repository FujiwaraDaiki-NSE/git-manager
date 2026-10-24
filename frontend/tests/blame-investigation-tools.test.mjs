import test from "node:test";
import assert from "node:assert/strict";
import {
  BLAME_LINE_ORDER_VALUES,
  blameCommitSummary,
  blameJson,
  blameRawLineContent,
  blameRawLineContentIsNonContiguous,
  filterBlameInvestigationLines,
  orderBlameLines,
  parseBlameCalendarDate,
  resolveBlameDateRange,
  resolveBlameLineSubset,
  visibleBlameCommitHashes,
} from "../app/blame-investigation-tools.mjs";

const dayOne = parseBlameCalendarDate("2024-01-10", "test date");
const dayTwo = parseBlameCalendarDate("2024-01-11", "test date");
const commitA = "a".repeat(40);
const commitB = "b".repeat(40);
const commitC = "c".repeat(40);
const lines = [
  { original_line: 3, final_line: 3, commit: commitA, author: "A", email: "a@example.test", time: dayTwo.start + 10, content: "third", summary: "newer", path: "sample.txt" },
  { original_line: 1, final_line: 1, commit: commitB, author: "B", email: "b@example.test", time: dayOne.start + 10, content: "first", summary: "older", path: "sample.txt" },
  { original_line: 2, final_line: 2, commit: commitA, author: "A", email: "a@example.test", time: dayTwo.start + 10, content: "second", summary: "newer", path: "sample.txt" },
  { original_line: 4, final_line: 4, commit: commitC, author: "C", email: "c@example.test", time: dayOne.start + 20, content: "fourth", summary: "older", path: "sample.txt" },
];

function explicitFilters(overrides = {}) {
  return {
    query: "",
    authorFilter: "",
    commitFilter: "",
    dateFrom: "",
    dateTo: "",
    subsetStart: "",
    subsetEnd: "",
    ...overrides,
  };
}

test("calendar date filters use local inclusive days and reject invalid or reversed dates", () => {
  const range = resolveBlameDateRange("2024-01-10", "2024-01-11");
  assert.equal(range.from, dayOne.start);
  assert.equal(range.toExclusive, dayTwo.endExclusive);
  assert.deepEqual(filterBlameInvestigationLines(lines, explicitFilters({ dateFrom: "2024-01-11", dateTo: "2024-01-11" })).map((line) => line.commit), [commitA, commitA]);
  assert.throws(() => resolveBlameDateRange("2024-01-12", "2024-01-11"), /終了日は開始日以降/);
  assert.throws(() => resolveBlameDateRange("2024-02-30", ""), /実在する日付/);
  assert.throws(() => resolveBlameDateRange("2024-1-01", ""), /YYYY-MM-DD/);
});

test("fetched-line subset accepts explicit blank bounds and validates positive safe integers", () => {
  assert.deepEqual(resolveBlameLineSubset("", ""), { start: null, end: null });
  assert.deepEqual(resolveBlameLineSubset(null, null), { start: null, end: null });
  assert.deepEqual(resolveBlameLineSubset("2", "3"), { start: 2, end: 3 });
  assert.deepEqual(filterBlameInvestigationLines(lines, explicitFilters({ subsetStart: "2", subsetEnd: "3" })).map((line) => line.final_line), [3, 2]);
  assert.throws(() => resolveBlameLineSubset("4", "3"), /表示終了行は表示開始行以上/);
  assert.throws(() => resolveBlameLineSubset("0", ""), /空欄、または1以上/);
  assert.throws(() => resolveBlameLineSubset("9007199254740992", ""), /大きすぎます/);
});

test("line ordering exposes all explicit modes and remains stable for equal keys", () => {
  assert.deepEqual(BLAME_LINE_ORDER_VALUES, ["current-ascending", "original-ascending", "newest", "oldest"]);
  assert.deepEqual(orderBlameLines(lines, "current-ascending").map((line) => line.final_line), [1, 2, 3, 4]);
  assert.deepEqual(orderBlameLines(lines, "original-ascending").map((line) => line.original_line), [1, 2, 3, 4]);
  assert.deepEqual(orderBlameLines(lines, "newest").map((line) => line.final_line), [3, 2, 4, 1]);
  assert.deepEqual(orderBlameLines(lines, "oldest").map((line) => line.final_line), [1, 4, 3, 2]);
  assert.throws(() => orderBlameLines(lines, "unknown"), /並び順/);
});

test("visible commit navigation and contribution summary use displayed rows", () => {
  const ordered = orderBlameLines(lines, "newest");
  assert.deepEqual(visibleBlameCommitHashes(ordered), [commitA, commitC, commitB]);
  assert.deepEqual(blameCommitSummary(ordered), [
    { commit: commitA, lineCount: 2, percent: 50 },
    { commit: commitC, lineCount: 1, percent: 25 },
    { commit: commitB, lineCount: 1, percent: 25 },
  ]);
});

test("raw content preserves displayed content and flags missing line boundaries", () => {
  const visible = [lines[1], lines[2], lines[3]];
  assert.equal(blameRawLineContent(visible), "first\nsecond\nfourth");
  assert.equal(blameRawLineContentIsNonContiguous(visible), true);
  assert.equal(blameRawLineContentIsNonContiguous([lines[1], lines[2], lines[0]]), false);
});

test("JSON export carries repository, revision, requested range, and every filter choice", () => {
  const json = JSON.parse(blameJson([lines[0], lines[2]], {
    repo: "/repo",
    revision: "HEAD",
    pinned_hash: "d".repeat(40),
    file: "sample.txt",
    requested_range: { start: 1, end: 4 },
    filters: {
      query: "second",
      author: "",
      commit: commitA,
      commit_date_from: "2024-01-11",
      commit_date_to: "2024-01-11",
      line_start: "2",
      line_end: "3",
      order: "newest",
    },
  }));
  assert.equal(json.repo, "/repo");
  assert.equal(json.revision, "HEAD");
  assert.equal(json.pinned_hash, "d".repeat(40));
  assert.deepEqual(json.requested_range, { start: 1, end: 4 });
  assert.equal(json.filters.order, "newest");
  assert.deepEqual(json.lines, [lines[0], lines[2]]);
});

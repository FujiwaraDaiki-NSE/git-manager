import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_BLAME_LINES,
  UNKNOWN_BLAME_AUTHOR_FILTER,
  blameAuthors,
  blameCommits,
  blameCsv,
  blameHashList,
  blameQuery,
  blameRequestKey,
  encodeBlameAuthor,
  filterBlameLines,
  hasUnknownBlameAuthor,
} from "../app/blame-explorer-tools.mjs";

const lines = [
  {
    original_line: 1,
    final_line: 1,
    commit: "a".repeat(40),
    author: "First Author",
    email: "first@example.test",
    time: 1_700_000_000,
    content: "<strong>one</strong>",
    summary: "base",
    path: "src/example.ts",
  },
  {
    original_line: 2,
    final_line: 2,
    commit: "b".repeat(40),
    author: "Second Author",
    email: "second@example.test",
    time: 1_700_000_100,
    content: "two\twith tab",
    summary: "=formula-looking subject",
    path: "src/example.ts",
  },
  {
    original_line: 3,
    final_line: 3,
    commit: "a".repeat(40),
    author: null,
    email: null,
    time: 1_700_000_200,
    content: "three",
    summary: "follow-up",
    path: "old name.ts",
  },
];

test("blame filters use exact author and commit values from retrieved rows", () => {
  assert.deepEqual(blameAuthors(lines), ["First Author", "Second Author"]);
  assert.deepEqual(blameCommits(lines), ["a".repeat(40), "b".repeat(40)]);
  assert.equal(hasUnknownBlameAuthor(lines), true);
  assert.deepEqual(filterBlameLines(lines, "", encodeBlameAuthor("Second Author"), ""), [lines[1]]);
  assert.deepEqual(filterBlameLines(lines, "", "", "a".repeat(40)), [lines[0], lines[2]]);
  assert.deepEqual(filterBlameLines(lines, "<strong>", "", ""), [lines[0]]);
  assert.deepEqual(filterBlameLines(lines, "", UNKNOWN_BLAME_AUTHOR_FILTER, ""), [lines[2]]);
  assert.deepEqual(filterBlameLines(lines, "", encodeBlameAuthor("second author"), ""), []);
  assert.throws(() => filterBlameLines(lines, "", ""), /explicitly/);
});

test("blame CSV preserves content and neutralizes spreadsheet formulas", () => {
  const csv = blameCsv(lines);
  assert.ok(csv.startsWith("\uFEFF\"final_line\",\"original_line\""));
  assert.ok(csv.includes("\"'=formula-looking subject\""));
  assert.ok(csv.includes("\"<strong>one</strong>\""));
  assert.ok(csv.includes("two\twith tab"));
  assert.equal(blameHashList(lines), `${lines[0].commit}\n${lines[1].commit}\n${lines[2].commit}`);
});

test("blame request helpers keep every explicit range parameter", () => {
  const query = blameQuery("/repo", "HEAD", "src/example [x].ts", 2, 9);
  assert.equal(query, "path=%2Frepo&revision=HEAD&file=src%2Fexample+%5Bx%5D.ts&start=2&end=9");
  assert.equal(blameRequestKey("/repo", "HEAD", "src/example.ts", 2, 9), JSON.stringify(["/repo", "HEAD", "src/example.ts", 2, 9]));
  assert.throws(() => blameQuery("/repo", "HEAD", "src/example.ts", 0, 2), /explicitly/);
  assert.throws(() => blameQuery("/repo", "HEAD", "src/example.ts", 1, MAX_BLAME_LINES + 1), /explicitly/);
  assert.equal(blameRequestKey("/repo", "HEAD", "src/example.ts", 2, 1), null);
  assert.throws(() => blameQuery("/repo", "HEAD", "src/example.ts", 1), /explicitly/);
});

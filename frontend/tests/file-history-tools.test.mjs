import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeFileHistoryAuthor,
  fileHistoryAuthors,
  fileHistoryCsv,
  fileHistoryHashList,
  fileHistoryQuery,
  filterFileHistory,
  hasUnknownFileHistoryAuthor,
  UNKNOWN_FILE_HISTORY_AUTHOR_FILTER,
} from "../app/file-history-tools.mjs";

const records = [
  { hash: "a".repeat(40), subject: "Update", author: "Aki", date: "2026-10-01T10:00:00Z", status: "M", path: "src/a.ts", old_path: null },
  { hash: "b".repeat(40), subject: "Rename", author: "Ren", date: "2026-09-30T10:00:00Z", status: "R100", path: "src/new.ts", old_path: "src/old.ts" },
  { hash: "c".repeat(40), subject: null, author: null, date: null, status: "D", path: "gone.txt", old_path: null },
];

test("file history authors and filtering use exact retrieved values", () => {
  assert.deepEqual(fileHistoryAuthors(records), ["Aki", "Ren"]);
  assert.equal(hasUnknownFileHistoryAuthor(records), true);
  assert.deepEqual(filterFileHistory(records, "update", encodeFileHistoryAuthor("Aki")), [records[0]]);
  assert.deepEqual(filterFileHistory(records, "", UNKNOWN_FILE_HISTORY_AUTHOR_FILTER), [records[2]]);
  assert.deepEqual(filterFileHistory(records, "old.ts", ""), [records[1]]);
  assert.deepEqual(filterFileHistory(records, "aki", encodeFileHistoryAuthor("aki")), []);
  assert.throws(() => filterFileHistory(records, ""), /authorFilter/);
});

test("CSV keeps multiline paths and neutralizes spreadsheet formulas", () => {
  const csv = fileHistoryCsv([{
    ...records[0],
    subject: "=SUM(1,2)\nquoted",
    author: "@user",
    path: "line\n+name.txt",
  }]);
  assert.ok(csv.startsWith("\uFEFF\"hash\",\"subject\""));
  assert.ok(csv.includes("\"'=SUM(1,2)\nquoted\""));
  assert.ok(csv.includes("\"'@user\""));
  assert.ok(csv.includes("line\n+name.txt"));
  assert.equal(fileHistoryHashList(records), `${records[0].hash}\n${records[1].hash}\n${records[2].hash}`);
});

test("file history query always includes every explicit request parameter", () => {
  const query = fileHistoryQuery("/repo", "HEAD", "src/a [glob].ts", true, 100);
  assert.equal(query, "path=%2Frepo&revision=HEAD&file=src%2Fa+%5Bglob%5D.ts&follow=true&offset=100");
  assert.throws(() => fileHistoryQuery("/repo", "HEAD", "src/a.ts", true), /explicitly/);
  assert.throws(() => fileHistoryQuery("/repo", "HEAD", "src/a.ts", false, -1), /explicitly/);
});


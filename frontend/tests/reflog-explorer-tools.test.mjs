import test from "node:test";
import assert from "node:assert/strict";
import {
  filterReflog,
  historyCsv,
  isValidReflogRef,
  localCalendarDate,
  localReflogCalendarDate,
  reflogCommand,
  reflogCsv,
  reflogDateRangeError,
  reflogHashList,
  reflogRequestQuery,
  searchReflog,
} from "../app/reflog-explorer-tools.mjs";

const records = [
  {
    hash: "a".repeat(40),
    selector: "HEAD@{2026-10-01T10:00:00+09:00}",
    message: "commit: Fix parser",
    actor: "Aki <aki@example.test>",
    date: "2026-10-01T10:00:00+09:00",
  },
  {
    hash: "b".repeat(40),
    selector: "HEAD@{2026-09-30T10:00:00+09:00}",
    message: "checkout: moving from main to feature",
    actor: "Ren <ren@example.test>",
    date: "2026-09-30T10:00:00+09:00",
  },
  {
    hash: "c".repeat(40),
    selector: "HEAD@{unknown}",
    message: null,
    actor: null,
    date: null,
  },
];

test("reflog search intersects action/message, hash, and actor terms", () => {
  assert.deepEqual(filterReflog(records, "FIX aki", null, null), [records[0]]);
  assert.deepEqual(searchReflog(records, "feature ren", null, null), [records[1]]);
  assert.deepEqual(filterReflog(records, "commit", null, null), [records[0]]);
  assert.deepEqual(filterReflog(records, "null", null, null), []);
});

test("reflog date boundaries use local calendar days and exclude unknown dates", () => {
  const start = { ...records[0], hash: "d".repeat(40), date: "2026-10-01T23:30:00-05:00" };
  const end = { ...records[1], hash: "e".repeat(40), date: "2026-10-02T00:30:00+09:00" };
  assert.deepEqual(filterReflog([start, end, records[2]], "", "2026-10-02", "2026-10-02").map((record) => record.hash), [start.hash, end.hash]);
  assert.equal(localReflogCalendarDate("2026-10-01T23:30:00-05:00"), "2026-10-02");
  assert.equal(localCalendarDate("2026-02-30T10:00:00+09:00"), null);
  assert.match(reflogDateRangeError("2026-10-03", "2026-10-02"), /以前/);
  assert.match(reflogDateRangeError("2026-02-30", null), /有効な日付/);
  assert.deepEqual(filterReflog(records, "", "2026-10-03", "2026-10-02"), []);
});

test("filter inputs must be explicit", () => {
  assert.throws(() => filterReflog(records, ""), /provided explicitly/);
  assert.throws(() => filterReflog(records, "", null, undefined), /provided explicitly/);
  assert.throws(() => reflogDateRangeError(null, undefined), /provided explicitly/);
});

test("CSV preserves text and protects spreadsheet formulas", () => {
  const csv = reflogCsv([{
    ...records[0],
    message: " =SUM(1,2)\n\"quoted\"",
    actor: "@person",
  }]);
  assert.equal(csv, "\uFEFF\"hash\",\"selector\",\"message\",\"actor\",\"date\"\r\n\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"HEAD@{2026-10-01T10:00:00+09:00}\",\"' =SUM(1,2)\n\"\"quoted\"\"\",\"'@person\",\"2026-10-01T10:00:00+09:00\"");
  assert.match(reflogCsv([{ ...records[0], message: "\uFEFF=1+1" }]), /\"'\uFEFF=1\+1\"/);
  assert.equal(historyCsv([{ ...records[0], message: "=1" }]).startsWith("\uFEFF\"hash\""), true);
  assert.equal(reflogHashList(records.slice(0, 2)), `${"a".repeat(40)}\n${"b".repeat(40)}`);
});

test("only explicit refs are accepted and request/command preserve them", () => {
  assert.equal(isValidReflogRef("HEAD"), true);
  assert.equal(isValidReflogRef("refs/heads/topic/one"), true);
  assert.equal(isValidReflogRef("refs/remotes/origin/main"), true);
  assert.equal(isValidReflogRef("refs/stash"), true);
  for (const value of ["", "main", "refs/tags/v1", "HEAD~1", "HEAD@{1}", "--all", "refs/heads/a..b", "refs/heads/a b", "refs/heads/.hidden"]) {
    assert.equal(isValidReflogRef(value), false, value);
  }
  assert.equal(reflogRequestQuery("/tmp/repo", "refs/heads/topic"), "path=%2Ftmp%2Frepo&ref=refs%2Fheads%2Ftopic");
  assert.throws(() => reflogRequestQuery("/tmp/repo", ""), /explicit/);
  assert.equal(reflogCommand("/tmp/it's repo", "HEAD"), "git -C '/tmp/it'\\''s repo' log -g --date=iso-strict 'HEAD'");
  assert.equal(reflogCommand("/tmp/repo", "refs/heads/a..b"), null);
});


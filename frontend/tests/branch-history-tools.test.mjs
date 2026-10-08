import test from "node:test";
import assert from "node:assert/strict";
import {
  commitHeader,
  encodeHistoryAuthor,
  filterHistory,
  hasUnknownAuthor,
  historyAuthors,
  historyCsv,
  historyDateRangeError,
  historyHashList,
  historyLogCommand,
  historyRequestKey,
  localCalendarDate,
  sortHistory,
  UNKNOWN_AUTHOR_FILTER,
} from "../app/branch-history-tools.mjs";

const commits = [
  { hash: "abc123", subject: "Fix search", author: "Aki", date: "2026-10-01T10:00:00Z", isMerge: false },
  { hash: "def456", subject: "Merge feature", author: "Ren", date: "2026-09-30T10:00:00Z", isMerge: true },
  { hash: "ghi789", subject: null, author: null, date: null, isMerge: false },
];
test("history search intersects words across subject, author and hash", () => {
  assert.deepEqual(filterHistory(commits, "FIX aki ABC", "all", null, null, null), [commits[0]]);
  assert.deepEqual(filterHistory(commits, "null", "all", null, null, null), []);
  assert.deepEqual(filterHistory(commits, "ren", "regular", null, null, null), []);
  assert.deepEqual(filterHistory(commits, "", "merge", null, null, null), [commits[1]]);
  assert.deepEqual(filterHistory([{ ...commits[2], isMerge: null }], "", "regular", null, null, null), []);
  assert.deepEqual(filterHistory([{ ...commits[2], isMerge: null }], "", "merge", null, null, null), []);
});

test("author filtering is exact and exposes missing authors separately", () => {
  assert.deepEqual(filterHistory(commits, "", "all", "Aki", null, null), [commits[0]]);
  assert.deepEqual(filterHistory(commits, "", "all", "aki", null, null), []);
  assert.deepEqual(filterHistory(commits, "", "all", UNKNOWN_AUTHOR_FILTER, null, null), [commits[2]]);
  const sentinelAuthor = { ...commits[0], author: UNKNOWN_AUTHOR_FILTER };
  assert.deepEqual(filterHistory([sentinelAuthor], "", "all", encodeHistoryAuthor(UNKNOWN_AUTHOR_FILTER), null, null), [sentinelAuthor]);
  assert.deepEqual(historyAuthors([{ author: "Ren" }, { author: "Aki" }, { author: "Ren" }, { author: null }]), ["Aki", "Ren"]);
  assert.equal(hasUnknownAuthor([{ author: "" }, { author: "Aki" }]), true);
});

test("new history filter parameters must be explicit", () => {
  assert.throws(() => filterHistory(commits, "", "all"), /provided explicitly/);
  assert.throws(() => filterHistory(commits, "", "all", null, null, undefined), /provided explicitly/);
  assert.throws(() => historyDateRangeError(null, undefined), /provided explicitly/);
});

test("calendar filters include both local boundaries and exclude unknown or malformed dates", () => {
  const boundaryStart = { ...commits[0], hash: "boundary-start", date: "2026-10-01T23:30:00-05:00" };
  const boundaryEnd = { ...commits[1], hash: "boundary-end", date: "2026-10-02T00:30:00+09:00" };
  const unknown = { ...commits[2], hash: "unknown-date", date: null };
  const malformed = { ...commits[2], hash: "malformed-date", date: "2026-02-30T10:00:00+09:00" };
  const rows = [boundaryStart, boundaryEnd, unknown, malformed];
  assert.deepEqual(filterHistory(rows, "", "all", null, "2026-10-02", "2026-10-02").map((commit) => commit.hash), ["boundary-start", "boundary-end"]);
  assert.equal(localCalendarDate("2026-10-01T23:30:00-05:00"), "2026-10-02");
  assert.equal(localCalendarDate("malformed"), null);
  assert.match(historyDateRangeError("2026-10-03", "2026-10-02"), /以前/);
  assert.deepEqual(filterHistory(rows, "", "all", null, "2026-10-03", "2026-10-02"), []);
  assert.match(historyDateRangeError("2026-02-30", null), /有効な日付/);
});
test("date ordering keeps unknown dates last without mutating Git order", () => {
  assert.deepEqual(sortHistory(commits, "oldest"), [commits[1], commits[0], commits[2]]);
  assert.deepEqual(sortHistory(commits, "newest"), commits);
  assert.deepEqual(sortHistory(commits, "git"), commits);
  assert.deepEqual(sortHistory([{...commits[0],date:"invalid"},commits[1]],"newest").map(c=>c.hash),["def456","abc123"]);
});
test("CSV preserves multiline and quotes, prevents spreadsheet formulas, and leaves unknown blank", () => {
  const csv = historyCsv([{...commits[0],subject:' =SUM(1,2)\n"quoted"',author:'@evil',date:null}]);
  assert.ok(csv.startsWith('\uFEFF"hash","subject"'));
  assert.ok(csv.includes('"\' =SUM(1,2)\n""quoted"""'));
  assert.ok(csv.includes('"\'@evil","","commit"'));
  assert.ok(historyCsv([{ ...commits[2], isMerge: null }]).includes('"ghi789","","","","unknown"'));
});

test("hash copying covers every filtered row and log commands quote path and immutable heads", () => {
  const sha = "a".repeat(40);
  const sha256 = "b".repeat(64);
  assert.equal(historyHashList([{ hash: sha }, { hash: sha256 }]), `${sha}\n${sha256}`);
  assert.equal(
    historyLogCommand("/tmp/it's repo", [sha, sha256]),
    `git -C '/tmp/it'\\''s repo' log --date-order '${sha}' '${sha256}'`,
  );
  assert.equal(historyLogCommand("/tmp/repo", ["short-hash"]), null);
  assert.equal(historyLogCommand("/tmp/repo", [sha, "--all"]), null);
  assert.equal(historyLogCommand("", [sha]), null);
});

test("request identity is stable across pagination but changes with project, row, heads, or seed", () => {
  const first = historyRequestKey("/repo", "row-a", ["head-a"], ["hash-a"]);
  assert.equal(first, historyRequestKey("/repo", "row-a", ["head-a"], ["hash-a"]));
  assert.notEqual(first, historyRequestKey("/repo", "row-a", ["head-b"], ["hash-a"]));
  assert.notEqual(first, historyRequestKey("/repo", "row-b", ["head-a"], ["hash-a"]));
  assert.notEqual(first, historyRequestKey("/other", "row-a", ["head-a"], ["hash-a"]));
  assert.notEqual(first, historyRequestKey("/repo", "row-a", ["head-a"], ["hash-b"]));
});

test("paginated commit detail uses fetched author and date only for the selected hash", () => {
  const event = { commit_hash: "page2", subject: null, author: null, occurred_at: null };
  const detail = { hash: "page2", subject: "Old change", author: "Aki", date: "2026-08-01T10:00:00Z" };
  assert.deepEqual(commitHeader(event, detail), { subject: "Old change", author: "Aki", date: "2026-08-01T10:00:00Z" });
  assert.deepEqual(commitHeader(event, { ...detail, hash: "different" }), { subject: null, author: null, date: null });
  assert.deepEqual(commitHeader(event, null), { subject: null, author: null, date: null });
});

import test from "node:test";
import assert from "node:assert/strict";
import { filterHistory, sortHistory, historyCsv, historyRequestKey, commitHeader } from "../app/branch-history-tools.mjs";

const commits = [
  { hash: "abc123", subject: "Fix search", author: "Aki", date: "2026-10-01T10:00:00Z", isMerge: false },
  { hash: "def456", subject: "Merge feature", author: "Ren", date: "2026-09-30T10:00:00Z", isMerge: true },
  { hash: "ghi789", subject: null, author: null, date: null, isMerge: false },
];
test("history search intersects words across subject, author and hash", () => {
  assert.deepEqual(filterHistory(commits, "FIX aki ABC", "all"), [commits[0]]);
  assert.deepEqual(filterHistory(commits, "null", "all"), []);
  assert.deepEqual(filterHistory(commits, "ren", "regular"), []);
  assert.deepEqual(filterHistory(commits, "", "merge"), [commits[1]]);
  assert.deepEqual(filterHistory([{ ...commits[2], isMerge: null }], "", "regular"), []);
  assert.deepEqual(filterHistory([{ ...commits[2], isMerge: null }], "", "merge"), []);
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

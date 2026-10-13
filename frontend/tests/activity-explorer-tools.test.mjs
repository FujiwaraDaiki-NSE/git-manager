import test from "node:test";
import assert from "node:assert/strict";
import {
  activityAuthors,
  activityBranches,
  activityCsv,
  activityDateRangeError,
  activityMarkdown,
  encodeActivityAuthor,
  encodeActivityBranch,
  filterActivityDetails,
  filterActivityEvents,
  hasUnknownAuthor,
  hasUnknownBranch,
  localCalendarDate,
  UNKNOWN_AUTHOR_FILTER,
  UNKNOWN_BRANCH_FILTER,
} from "../app/activity-explorer-tools.mjs";

function event(id, values = {}) {
  return {
    id,
    occurred_at: "2026-10-02T12:00:00Z",
    observed_at: 1,
    type: "commit",
    source: "git",
    branch: null,
    lane_names: [],
    commit_hash: null,
    subject: null,
    author: null,
    ...values,
  };
}

function options(values = {}) {
  return {
    authorFilter: null,
    branchFilter: null,
    startDate: null,
    endDate: null,
    ...values,
  };
}

test("author and associated branch selectors use exact values and expose unknowns", () => {
  const records = [
    event("one", { author: "Alice", branch: "feature/a", lane_names: ["origin/feature/a"] }),
    event("two", { author: "alice", branch: "feature/ab", lane_names: ["feature/ab"] }),
    event("three", { author: null, branch: null, lane_names: [] }),
  ];
  assert.deepEqual(activityAuthors(records), ["alice", "Alice"]);
  assert.deepEqual(activityBranches(records), ["feature/a", "feature/ab", "origin/feature/a"]);
  assert.equal(hasUnknownAuthor(records), true);
  assert.equal(hasUnknownBranch(records), true);
  assert.deepEqual(filterActivityEvents(records, options({ authorFilter: encodeActivityAuthor("Alice") })).map((item) => item.id), ["one"]);
  assert.deepEqual(filterActivityEvents(records, options({ authorFilter: encodeActivityAuthor("alice") })).map((item) => item.id), ["two"]);
  assert.deepEqual(filterActivityEvents(records, options({ branchFilter: encodeActivityBranch("feature/a") })).map((item) => item.id), ["one"]);
  assert.deepEqual(filterActivityEvents(records, options({ branchFilter: encodeActivityBranch("feature") })), []);
  assert.deepEqual(filterActivityEvents(records, options({ authorFilter: UNKNOWN_AUTHOR_FILTER, branchFilter: UNKNOWN_BRANCH_FILTER })).map((item) => item.id), ["three"]);
});

test("activity filter parameters are explicit and malformed or reversed dates never fall back", () => {
  const records = [event("one")];
  assert.throws(() => filterActivityEvents(records, { authorFilter: null, branchFilter: null, startDate: null }), /provided explicitly/);
  assert.throws(() => activityDateRangeError("2026-10-03", undefined), /provided explicitly/);
  assert.match(activityDateRangeError("2026-02-30", null), /有効な日付/);
  assert.match(activityDateRangeError("2026-10-03", "2026-10-02"), /以前/);
  assert.deepEqual(filterActivityEvents(records, options({ startDate: "2026-10-03", endDate: "2026-10-02" })), []);
  assert.deepEqual(filterActivityEvents(records, options({ startDate: "2026-02-30", endDate: null })), []);
});

test("local calendar boundaries are inclusive and unknown timestamps are excluded from finite ranges", () => {
  const date = localCalendarDate("2026-10-02T12:00:00Z");
  assert.ok(date);
  const records = [
    event("boundary-start", { occurred_at: `${date}T00:00:00` }),
    event("boundary-end", { occurred_at: `${date}T23:59:59` }),
    event("unknown", { occurred_at: null }),
    event("malformed", { occurred_at: "2026-02-30T10:00:00Z" }),
  ];
  assert.deepEqual(filterActivityEvents(records, options({ startDate: date, endDate: date })).map((item) => item.id), ["boundary-start", "boundary-end"]);
  assert.equal(localCalendarDate("2026-02-30T10:00:00Z"), null);
  assert.equal(filterActivityDetails(records, options({ startDate: date, endDate: date })).finiteRangeUnknownDatesExcluded, true);
});

test("Markdown includes every matching record and CSV preserves unknowns and protects formulas", () => {
  const records = [
    event("formula", {
      source: "\n=HYPERLINK(\"https://evil.example\")",
      type: "review",
      author: "@person",
      branch: "feature/a",
      lane_names: ["feature/a", "origin/feature/a"],
      subject: "[review]| details\nnext",
      commit_hash: "abc123",
    }),
    event("unknown", { occurred_at: null }),
  ];
  const markdown = activityMarkdown(records);
  assert.match(markdown, /一致件数: 2/);
  assert.match(markdown, /feature\/a \/ origin\/feature\/a/);
  assert.match(markdown, /未取得/);
  assert.match(markdown, /\\\[review\\\]\\\| details<br>next/);
  const csv = activityCsv(records);
  assert.ok(csv.startsWith("\uFEFF\"source\",\"type\",\"date\",\"author\",\"branch\",\"subject\",\"hash\""));
  assert.match(csv, /"'\n=HYPERLINK\(""https:\/\/evil\.example""\)"/);
  assert.match(csv, /"'@person"/);
  assert.match(csv, /"git","commit","unknown","unknown","unknown","unknown","unknown"/);
  assert.ok(csv.endsWith("\r\n"));
});

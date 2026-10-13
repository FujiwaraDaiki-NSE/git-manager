import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPullRequestExplorerData,
  collectMergedPullRequests,
  dedupePullRequests,
  filterPullRequests,
  filterPullRequestDetails,
  localCalendarDate,
  pullRequestsToCsv,
  pullRequestDateRangeError,
  pullRequestUrlDetails,
  sourceOptions,
  sortPullRequests,
  targetBranchName,
  validHttpUrl,
} from "../app/pr-tools.mjs";

const observedAt = Date.parse("2026-10-02T00:00:00Z") / 1000;

function pr(number, overrides = {}) {
  return {
    number,
    url: `https://github.com/example/repo/pull/${number}`,
    source: `example:feature-${number}`,
    target: "example:main",
    commit_hash: `hash-${number}`,
    merged_at: "2026-09-30T00:00:00Z",
    ...overrides,
  };
}

function filterOptions(overrides = {}) {
  return { query: "", target: "all", source: "all", range: "all", startDate: null, endDate: null, observedAt, ...overrides };
}

test("collectMergedPullRequests deduplicates a PR attached to multiple branch rows", () => {
  const result = collectMergedPullRequests({
    branch_rows: [
      { id: "remote:feature", pull_requests: [pr(12)] },
      { id: "history:pr:12", pull_requests: [pr(12), pr(11)] },
    ],
  });

  assert.deepEqual(result.map((item) => item.number), [12, 11]);
  assert.equal(result.length, 2);
});

test("dedupe keeps the first record and preserves its nullable fields", () => {
  const result = dedupePullRequests([
    pr(4, { commit_hash: null, merged_at: null }),
    pr(4, { source: null, commit_hash: "merge-4", merged_at: "2026-09-29T00:00:00Z" }),
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].source, `example:feature-4`);
  assert.equal(result[0].commit_hash, null);
  assert.equal(result[0].merged_at, null);
});

test("search matches number, source, target, and merge hash", () => {
  const records = [pr(7), pr(8, { source: "fork:release", target: "example:release", commit_hash: "deadbeef" })];
  assert.deepEqual(filterPullRequests(records, filterOptions({ query: "#8" })).map((item) => item.number), [8]);
  assert.deepEqual(filterPullRequests(records, filterOptions({ query: "fork:release" })).map((item) => item.number), [8]);
  assert.deepEqual(filterPullRequests(records, filterOptions({ query: "example:main" })).map((item) => item.number), [7]);
  assert.deepEqual(filterPullRequests(records, filterOptions({ query: "deadbeef" })).map((item) => item.number), [8]);
});

test("target filter accepts the full target identity or its branch portion", () => {
  const records = [pr(1), pr(2, { target: "example:release" })];
  assert.equal(targetBranchName("example:release"), "release");
  assert.deepEqual(filterPullRequests(records, filterOptions({ target: "release" })).map((item) => item.number), [2]);
  assert.deepEqual(filterPullRequests(records, filterOptions({ target: "example:main" })).map((item) => item.number), [1]);
});

test("source options preserve exact backend source identities and filter without shortening", () => {
  const records = [
    pr(1, { source: "owner/repo:feature/a" }),
    pr(2, { source: "fork/repo:feature/a" }),
    pr(3, { source: "owner/repo:feature/a" }),
  ];
  assert.deepEqual(sourceOptions(records), ["fork/repo:feature/a", "owner/repo:feature/a"]);
  assert.deepEqual(filterPullRequests(records, filterOptions({ source: "owner/repo:feature/a" })).map((item) => item.number), [1, 3]);
  assert.deepEqual(filterPullRequests(records, filterOptions({ source: "feature/a" })), []);
});

test("7 and 30 day ranges use observed_at as the inclusive window anchor", () => {
  const records = [
    pr(1, { merged_at: "2026-10-01T23:59:59Z" }),
    pr(2, { merged_at: "2026-09-24T00:00:00Z" }),
    pr(3, { merged_at: "2026-09-01T00:00:00Z" }),
  ];

  assert.deepEqual(filterPullRequests(records, filterOptions({ range: "7" })).map((item) => item.number), [1]);
  assert.deepEqual(filterPullRequests(records, filterOptions({ range: "30" })).map((item) => item.number), [1, 2]);
  assert.deepEqual(filterPullRequests(records, filterOptions({ range: "all" })).map((item) => item.number), [1, 2, 3]);
});

test("unknown merged dates are explicit: excluded from finite windows and retained for all", () => {
  const records = [pr(1, { merged_at: null }), pr(2, { merged_at: "invalid" }), pr(3)];
  const details = filterPullRequestDetails(records, filterOptions({ range: "7" }));
  assert.equal(details.unknownDates, 2);
  assert.equal(details.finiteRangeUnknownDatesExcluded, true);
  assert.deepEqual(details.records.map((item) => item.number), [3]);
  assert.deepEqual(filterPullRequests(records, filterOptions({ range: "all" })).map((item) => item.number), [1, 2, 3]);
});

test("missing observed_at keeps records visible but reports an unknown date window", () => {
  const details = filterPullRequestDetails([pr(1), pr(2, { merged_at: null })], filterOptions({ range: "7", observedAt: null }));
  assert.equal(details.dateWindow.state, "unknown");
  assert.deepEqual(details.records.map((item) => item.number), [1, 2]);
});

test("custom date ranges include local calendar boundaries across timezone offsets", () => {
  const records = [
    pr(1, { merged_at: "2026-10-01T23:30:00-05:00" }),
    pr(2, { merged_at: "2026-10-02T00:30:00+09:00" }),
    pr(3, { merged_at: "2026-10-03T00:00:00Z" }),
    pr(4, { merged_at: null }),
  ];
  assert.deepEqual(filterPullRequests(records, filterOptions({ range: "custom", startDate: "2026-10-02", endDate: "2026-10-02" })).map((item) => item.number), [1, 2]);
  assert.equal(localCalendarDate("2026-10-01T23:30:00-05:00"), "2026-10-02");
  assert.equal(localCalendarDate("2026-02-30T10:00:00+09:00"), null);
  assert.deepEqual(filterPullRequests(records, filterOptions({ range: "custom", startDate: "2026-10-03", endDate: "2026-10-02" })), []);
});

test("invalid custom ranges are explicit and never fall back to all records", () => {
  assert.match(pullRequestDateRangeError("2026-02-30", null), /有効な日付/);
  assert.match(pullRequestDateRangeError("2026-10-03", "2026-10-02"), /以前/);
  const details = filterPullRequestDetails([pr(1)], filterOptions({ range: "custom", startDate: "bad", endDate: null }));
  assert.equal(details.dateWindow.state, "invalid");
  assert.ok(details.dateWindow.error);
  assert.deepEqual(details.records, []);
});

test("newest and oldest sorts put unknown dates at the end; number is descending", () => {
  const records = [
    pr(4, { merged_at: null }),
    pr(2, { merged_at: "2026-09-28T00:00:00Z" }),
    pr(9, { merged_at: "2026-09-30T00:00:00Z" }),
  ];
  assert.deepEqual(sortPullRequests(records, "newest").map((item) => item.number), [9, 2, 4]);
  assert.deepEqual(sortPullRequests(records, "oldest").map((item) => item.number), [2, 9, 4]);
  assert.deepEqual(sortPullRequests(records, "number").map((item) => item.number), [9, 4, 2]);
});

test("CSV is filtered input, RFC quoted, and protected against spreadsheet formulas", () => {
  const csv = pullRequestsToCsv([
    pr(10, { source: "=HYPERLINK(\"https://evil.example\")", target: "+CMD", commit_hash: "@unsafe", merged_at: "2026-09-30T00:00:00Z" }),
  ]);
  assert.match(csv, /^"number","source","target","commit_hash","merged_at","url"\r\n/);
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/evil\.example""\)"/);
  assert.match(csv, /"'\+CMD"/);
  assert.match(csv, /"'@unsafe"/);
  assert.ok(!csv.includes("HYPERLINK(\"https://evil.example\")"));
});

test("PR URL copying includes only valid http(s) links and reports exclusions", () => {
  const records = [
    pr(1),
    pr(2, { url: "javascript:alert(1)" }),
    pr(3, { url: "not a URL" }),
    pr(4, { url: "http://example.test/pull/4" }),
  ];
  assert.equal(validHttpUrl(records[0].url), records[0].url);
  assert.equal(validHttpUrl(records[1].url), null);
  assert.deepEqual(pullRequestUrlDetails(records), {
    urls: [records[0].url, records[3].url],
    value: `${records[0].url}\n${records[3].url}`,
    validCount: 2,
    invalidCount: 2,
  });
});

test("CSV export is built from the records after every active filter", () => {
  const project = {
    github: { status: "available" },
    observed_at: observedAt,
    branch_rows: [{ pull_requests: [
      pr(1, { source: "owner/repo:feature/a", merged_at: "2026-10-01T23:30:00-05:00" }),
      pr(2, { source: "owner/repo:feature/b", merged_at: "2026-10-02T12:00:00Z" }),
    ] }],
  };
  const model = buildPullRequestExplorerData(project, {
    query: "",
    target: "all",
    source: "owner/repo:feature/a",
    range: "custom",
    startDate: "2026-10-02",
    endDate: "2026-10-02",
    sort: "newest",
  });
  assert.deepEqual(model.filtered.map((item) => item.number), [1]);
  const csv = pullRequestsToCsv(model.filtered);
  assert.match(csv, /pull\/1/);
  assert.ok(!csv.includes("pull/2"));
});

test("explorer model exposes unavailable coverage instead of manufacturing empty success", () => {
  const options = { query: "", target: "all", source: "all", range: "all", startDate: null, endDate: null, sort: "newest" };
  const unknown = buildPullRequestExplorerData({ github: { status: "available" }, branch_rows: null, observed_at: observedAt }, options);
  assert.equal(unknown.coverage, "unknown");
  assert.equal(unknown.all.length, 0);

  const unavailable = buildPullRequestExplorerData({ github: { status: "unavailable" }, branch_rows: [], observed_at: observedAt }, options);
  assert.equal(unavailable.coverage, "unavailable");
  assert.equal(unavailable.githubStatus, "unavailable");
});

test("explorer model preserves chosen sort after filtering and deduplication", () => {
  const project = { github: { status: "available" }, observed_at: observedAt, branch_rows: [{ pull_requests: [pr(2), pr(9), pr(4)] }] };
  const model = buildPullRequestExplorerData(project, { query: "", target: "all", source: "all", range: "all", startDate: null, endDate: null, sort: "number" });
  assert.deepEqual(model.filtered.map((item) => item.number), [9, 4, 2]);
});

test("new PR filter parameters must be provided explicitly", () => {
  assert.throws(() => filterPullRequests([pr(1)], { query: "", target: "all", range: "all", observedAt }), /provided explicitly/);
  assert.throws(() => pullRequestDateRangeError(null, undefined), /provided explicitly/);
});

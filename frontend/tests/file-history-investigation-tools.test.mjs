import test from "node:test";
import assert from "node:assert/strict";
import {
  adjacentFileHistory,
  fileHistoryChangeKind,
  fileHistoryCommitMarkdown,
  fileHistoryDateRangeError,
  fileHistoryJson,
  fileHistoryTopology,
  filterFileHistoryInvestigation,
  FILE_HISTORY_CHANGE_ALL,
  FILE_HISTORY_CHANGE_UNKNOWN,
  FILE_HISTORY_ORDER_GIT,
  FILE_HISTORY_ORDER_NEWEST,
  FILE_HISTORY_ORDER_OLDEST,
  FILE_HISTORY_ORDER_SUBJECT,
  FILE_HISTORY_TOPOLOGY_ALL,
  FILE_HISTORY_TOPOLOGY_MERGE,
  FILE_HISTORY_TOPOLOGY_NON_MERGE,
  localFileHistoryCalendarDate,
  sortFileHistory,
} from "../app/file-history-investigation-tools.mjs";

const records = [
  { hash: "merge", short: "merge", subject: "Merge feature", author: "Ren", date: "2026-10-03T10:00:00Z", parents: ["p1", "p2"], status: null, path: "src/file.ts", old_path: null },
  { hash: "modify", short: "modify", subject: "Update parser", author: "Aki", date: "2026-10-02T10:00:00Z", parents: ["p3"], status: "M", path: "src/file.ts", old_path: null },
  { hash: "rename", short: "rename", subject: "Rename parser", author: "Aki", date: "2026-10-01T10:00:00Z", parents: ["p4"], status: "R100", path: "src/file.ts", old_path: "src/old.ts" },
  { hash: "add", short: "add", subject: "Add parser", author: "Aki", date: "2026-09-30T10:00:00Z", parents: [], status: "A", path: "src/file.ts", old_path: null },
  { hash: "unknown", short: "unknown", subject: null, author: null, date: null, parents: undefined, status: null, path: "src/file.ts", old_path: null },
];

function options(overrides = {}) {
  return {
    query: "",
    authorFilter: "",
    startDate: "",
    endDate: "",
    changeKind: FILE_HISTORY_CHANGE_ALL,
    topology: FILE_HISTORY_TOPOLOGY_ALL,
    ...overrides,
  };
}

test("inclusive local-calendar dates filter only finite, valid commit instants", () => {
  const instant = "2026-10-01T23:30:00-05:00";
  const localDay = localFileHistoryCalendarDate(instant);
  const boundary = { ...records[2], hash: "boundary", date: instant };
  const rows = [boundary, { ...records[4], hash: "malformed", date: "2026-02-30T10:00:00Z" }];
  assert.equal(localDay !== null, true);
  assert.deepEqual(
    filterFileHistoryInvestigation(rows, options({ startDate: localDay, endDate: localDay })).map((record) => record.hash),
    ["boundary"],
  );
  assert.equal(localFileHistoryCalendarDate("2026-02-30T10:00:00Z"), null);
  assert.match(fileHistoryDateRangeError("2026-10-03", "2026-10-02"), /以前/);
  assert.match(fileHistoryDateRangeError("2026-02-30", ""), /有効な日付/);
  assert.throws(() => fileHistoryDateRangeError("2026-10-01"), /provided explicitly/);
});

test("Git, newest, oldest, and subject ordering is stable and non-mutating", () => {
  const gitOrder = sortFileHistory(records, FILE_HISTORY_ORDER_GIT).map((record) => record.hash);
  const newest = sortFileHistory(records, FILE_HISTORY_ORDER_NEWEST).map((record) => record.hash);
  const oldest = sortFileHistory(records, FILE_HISTORY_ORDER_OLDEST).map((record) => record.hash);
  const subject = sortFileHistory(records, FILE_HISTORY_ORDER_SUBJECT).map((record) => record.hash);
  assert.deepEqual(gitOrder, ["merge", "modify", "rename", "add", "unknown"]);
  assert.deepEqual(newest, ["merge", "modify", "rename", "add", "unknown"]);
  assert.deepEqual(oldest, ["add", "rename", "modify", "merge", "unknown"]);
  assert.deepEqual(subject, ["add", "merge", "rename", "modify", "unknown"]);
  assert.deepEqual(records.map((record) => record.hash), ["merge", "modify", "rename", "add", "unknown"]);
});

test("change-kind and topology filters remain exact, including explicit unknowns", () => {
  assert.equal(fileHistoryChangeKind(records[2]), "R");
  assert.equal(fileHistoryTopology(records[0]), FILE_HISTORY_TOPOLOGY_MERGE);
  assert.equal(fileHistoryTopology(records[4]), "unknown");
  assert.deepEqual(filterFileHistoryInvestigation(records, options({ changeKind: "R" })).map((record) => record.hash), ["rename"]);
  assert.deepEqual(filterFileHistoryInvestigation(records, options({ changeKind: "M" })).map((record) => record.hash), ["modify"]);
  assert.deepEqual(filterFileHistoryInvestigation(records, options({ changeKind: FILE_HISTORY_CHANGE_UNKNOWN })).map((record) => record.hash), ["merge", "unknown"]);
  assert.deepEqual(filterFileHistoryInvestigation(records, options({ topology: FILE_HISTORY_TOPOLOGY_MERGE })).map((record) => record.hash), ["merge"]);
  assert.deepEqual(filterFileHistoryInvestigation(records, options({ topology: FILE_HISTORY_TOPOLOGY_NON_MERGE })).map((record) => record.hash), ["modify", "rename", "add"]);
  assert.deepEqual(filterFileHistoryInvestigation(records, options({ topology: "invalid" })), []);
});

test("adjacent navigation follows the supplied visible order without wrapping", () => {
  assert.deepEqual(adjacentFileHistory(records.slice(0, 3), "modify"), {
    index: 1,
    count: 3,
    previous: records[0],
    next: records[2],
  });
  assert.equal(adjacentFileHistory(records.slice(0, 3), "merge").previous, null);
  assert.equal(adjacentFileHistory(records.slice(0, 3), "rename").next, null);
  assert.equal(adjacentFileHistory(records.slice(0, 3), "missing").index, -1);
  assert.throws(() => adjacentFileHistory(records, undefined), /provided explicitly/);
});

test("JSON export contains only filtered rows and immutable page metadata", () => {
  const json = fileHistoryJson([records[1], records[2]], {
    revision: "HEAD",
    pinnedHash: "f".repeat(40),
    file: "src/file.ts",
    follow: true,
  });
  const value = JSON.parse(json);
  assert.deepEqual(value, {
    revision: "HEAD",
    pinned_hash: "f".repeat(40),
    file: "src/file.ts",
    follow: true,
    count: 2,
    commits: [records[1], records[2]],
  });
  assert.throws(() => fileHistoryJson([], { revision: "HEAD", file: "src/file.ts", follow: true }), /pinnedHash/);
});

test("selected commit Markdown report includes context, file stats, and patch text", () => {
  const markdown = fileHistoryCommitMarkdown({
    hash: "modify",
    subject: "Update <parser>",
    author: "Aki",
    date: "2026-10-02T10:00:00Z",
    parents: ["p3"],
    files: [{ old_path: null, path: "src/file.ts", additions: 4, deletions: 1, binary: false }],
    patch: "@@ -1 +1 @@\n-old\n+new",
    patch_truncated: false,
  }, {
    repositoryPath: "/repo/<demo>",
    file: "src/file.ts",
    record: records[1],
    revision: "HEAD",
    pinnedHash: "f".repeat(40),
    follow: false,
  });
  assert.match(markdown, /^# gitdash file history investigation/m);
  assert.match(markdown, /repository_path: \/repo\/&lt;demo&gt;/);
  assert.match(markdown, /pinned_hash: f{40}/);
  assert.match(markdown, /\| 未取得 \| src\/file\\\.ts \| 4 \| 1 \| false \|/);
  assert.match(markdown, /@@ -1 \+1 @@/);
  assert.match(markdown, /read_only: true/);
  assert.throws(() => fileHistoryCommitMarkdown({}, { repositoryPath: "/repo" }), /provided explicitly/);
});

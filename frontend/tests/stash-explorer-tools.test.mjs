import test from "node:test";
import assert from "node:assert/strict";
import {
  adjacentStashes,
  filterStashes,
  localStashCalendarDate,
  searchStashes,
  sortStashes,
  stashCommand,
  stashDateRangeError,
  stashHashList,
  stashInventoryCsv,
  stashInvestigationMarkdown,
  stashPartLabel,
} from "../app/stash-explorer-tools.mjs";

const stashes = [
  { hash: "a".repeat(40), selector: "stash@{0}", subject: "On main: fix parser", date: "2026-10-16T10:00:00+09:00" },
  { hash: "b".repeat(40), selector: "stash@{1}", subject: "On feature: docs", date: "2026-10-15T10:00:00+09:00" },
];

test("stash search matches subject and immutable hash while preserving inventory order", () => {
  assert.deepEqual(searchStashes(stashes, "PARSER"), [stashes[0]]);
  assert.deepEqual(searchStashes(stashes, "b".repeat(8)), [stashes[1]]);
  assert.deepEqual(searchStashes(stashes, ""), stashes);
  assert.deepEqual(searchStashes(stashes, "missing"), []);
});

test("stash commands use a shell-quoted host path and keep the hash command read-only", () => {
  const command = stashCommand("/tmp/repo with 'quote'", "git -c core.quotepath=false diff HASH^1 HASH --");
  assert.equal(command, "git -C '/tmp/repo with '\\''quote'\\''' -c core.quotepath=false diff HASH^1 HASH --");
  assert.equal(stashCommand("/tmp/repo", "git stash pop HASH"), null);
  assert.equal(stashCommand("/tmp/repo", "rm -rf /"), null);
  assert.equal(stashCommand("", "git diff HASH^1 HASH --"), null);
  assert.equal(stashPartLabel("tracked"), "追跡済みの変更");
  assert.equal(stashPartLabel("untracked"), "未追跡ファイル");
});

test("stash date filters use inclusive local calendar days and expose invalid ranges", () => {
  const records = [
    stashes[0],
    { ...stashes[1], date: "2026-10-02T23:30:00-05:00" },
    { hash: "c".repeat(40), selector: "stash@{2}", subject: "unknown", date: "" },
  ];
  assert.equal(localStashCalendarDate("2026-10-02T23:30:00-05:00"), "2026-10-03");
  assert.equal(localStashCalendarDate("2026-02-30T10:00:00+09:00"), null);
  assert.deepEqual(filterStashes(records, "", "2026-10-03", "2026-10-16").map((stash) => stash.hash), [stashes[0].hash, stashes[1].hash]);
  assert.match(stashDateRangeError("2026-10-17", "2026-10-16"), /以前/);
  assert.match(stashDateRangeError("2026-02-30", null), /有効な日付/);
  assert.deepEqual(filterStashes(records, "", "2026-10-17", "2026-10-16"), []);
  assert.deepEqual(filterStashes(records, "", "2026-10-16", null).map((stash) => stash.hash), [stashes[0].hash]);
  assert.throws(() => filterStashes(records, ""), /provided explicitly/);
  assert.throws(() => stashDateRangeError(null, undefined), /provided explicitly/);
});

test("stash ordering preserves Git order and stably puts unknown dates last", () => {
  const records = [
    { ...stashes[0], subject: "zeta", date: "2026-10-16T10:00:00+09:00" },
    { ...stashes[1], subject: "alpha", date: "2026-10-15T10:00:00+09:00" },
    { hash: "c".repeat(40), selector: "stash@{2}", subject: "alpha", date: "" },
    { hash: "d".repeat(40), selector: "stash@{3}", subject: "unknown", date: "not-a-date" },
  ];
  assert.deepEqual(sortStashes(records, "git"), records);
  assert.deepEqual(sortStashes(records, "newest").map((stash) => stash.hash), [records[0].hash, records[1].hash, records[2].hash, records[3].hash]);
  assert.deepEqual(sortStashes(records, "oldest").map((stash) => stash.hash), [records[1].hash, records[0].hash, records[2].hash, records[3].hash]);
  assert.deepEqual(sortStashes(records, "subject").map((stash) => stash.hash), [records[1].hash, records[0].hash, records[2].hash, records[3].hash]);
  assert.throws(() => sortStashes(records, "invalid"), /Unknown stash order/);
  assert.notStrictEqual(sortStashes(records, "git"), records);
});

test("filtered stash CSV and hash exports preserve exact values and protect formulas", () => {
  const filtered = [{
    ...stashes[0],
    subject: " =HYPERLINK(\"x\")",
    selector: "@danger",
  }];
  const csv = stashInventoryCsv(filtered);
  assert.equal(csv, '\uFEFF"hash","selector","subject","date"\r\n"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","\'@danger","\' =HYPERLINK(""x"")","2026-10-16T10:00:00+09:00"\r\n');
  assert.match(stashInventoryCsv([{ ...filtered[0], subject: "\uFEFF=SUM(1,2)" }]), /"'\uFEFF=SUM\(1,2\)"/);
  assert.equal(stashHashList(filtered), stashes[0].hash);
  assert.throws(() => stashInventoryCsv(null), /array/);
});

test("stash navigation only follows the supplied visible list and never wraps", () => {
  assert.deepEqual(adjacentStashes(stashes, stashes[0].hash), { index: 0, count: 2, previous: null, next: stashes[1] });
  assert.deepEqual(adjacentStashes(stashes, stashes[1].hash), { index: 1, count: 2, previous: stashes[0], next: null });
  assert.deepEqual(adjacentStashes([stashes[0]], stashes[1].hash), { index: -1, count: 1, previous: null, next: null });
  assert.deepEqual(adjacentStashes(stashes, null), { index: -1, count: 2, previous: null, next: null });
  assert.throws(() => adjacentStashes(stashes), /provided explicitly/);
});

test("stash investigation Markdown carries exact handoff facts and escapes display text", () => {
  const detail = {
    ...stashes[0],
    subject: "title | <unsafe>\nnext",
    tracked: {
      available: true,
      files: [{ path: "tracked|file.txt", additions: 1, deletions: 0, binary: false }],
      patch: "",
      patch_truncated: true,
      command: null,
    },
    untracked: {
      available: false,
      files: [],
      patch: "",
      patch_truncated: false,
      command: null,
    },
    command: "git diff",
    untracked_command: null,
  };
  const markdown = stashInvestigationMarkdown(detail, "/repo/<unsafe>");
  assert.match(markdown, /immutable_hash: a{40}/);
  assert.match(markdown, /repository_path: \/repo\/&lt;unsafe&gt;/);
  assert.match(markdown, /date: 2026-10-16T10:00:00\+09:00/);
  assert.match(markdown, /subject: title \\\| &lt;unsafe&gt;<br>next/);
  assert.match(markdown, /## tracked[\s\S]*available: true[\s\S]*file_count: 1[\s\S]*patch_truncated: true/);
  assert.ok(markdown.includes("tracked\\|file\\.txt"));
  assert.match(markdown, /## untracked[\s\S]*available: false[\s\S]*file_count: 0[\s\S]*patch_truncated: false/);
  assert.equal(markdown.includes("<unsafe>"), false);
  assert.throws(() => stashInvestigationMarkdown(detail, ""), /path/);
});


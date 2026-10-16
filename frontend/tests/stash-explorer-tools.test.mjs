import test from "node:test";
import assert from "node:assert/strict";
import { searchStashes, stashCommand, stashPartLabel } from "../app/stash-explorer-tools.mjs";

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


import test from "node:test";
import assert from "node:assert/strict";
import {
  GUIDE_DEFAULT_HISTORY_COUNTS,
  gitGuide,
  guideCommand,
  guideCommandText,
  guideCommands,
  guideDescription,
  guideMarkdown,
  guideMatches,
  parseGuideFavorites,
  validateGuideHistoryCount,
} from "../app/git-guide-data.mjs";
import { workspaceSnapshot } from "../app/workspace-snapshot.mjs";

test("guide search combines purpose/command and category", () => {
  assert.deepEqual(gitGuide.filter((item) => guideMatches(item, "WORKTREE", "ブランチ")).map((item) => item.id), ["worktrees"]);
  assert.equal(gitGuide.filter((item) => guideMatches(item, "worktree", "変更")).length, 0);
  assert.equal(gitGuide.filter((item) => guideMatches(item, "競合", "変更"))[0].id, "conflict");
});
test("repo paths are shell-quoted without expanding metacharacters", () => {
  assert.equal(guideCommand("/tmp/a'b $(secret)", "status"), "git -C '/tmp/a'\\''b $(secret)' status");
  assert.equal(guideCommand(null, "status"), "git status");
});
test("history counts are explicit, bounded, and reflected in all guide output", () => {
  const history = gitGuide.find((item) => item.id === "history");
  const reflog = gitGuide.find((item) => item.id === "reflog");
  const counts = { log: 42, reflog: 7 };
  assert.equal(guideCommandText(history, counts), "log --graph --oneline --decorate --all -42");
  assert.equal(guideCommandText(reflog, counts), "reflog -7");
  assert.match(guideDescription(history, counts), /直近42コミット/);
  assert.match(guideDescription(reflog, counts), /最近7件/);
  assert.deepEqual(guideCommands(null, [history, reflog], counts), ["git log --graph --oneline --decorate --all -42", "git reflog -7"]);
  assert.equal(guideCommandText(history, GUIDE_DEFAULT_HISTORY_COUNTS), "log --graph --oneline --decorate --all -30");
  assert.equal(validateGuideHistoryCount("1").value, 1);
  assert.equal(validateGuideHistoryCount("500").value, 500);
  assert.equal(validateGuideHistoryCount("0").valid, false);
  assert.equal(validateGuideHistoryCount("501").valid, false);
  assert.equal(validateGuideHistoryCount("4.2").valid, false);
  assert.throws(() => guideCommandText(history, { log: 0, reflog: 7 }), /履歴件数が不正/);
});
test("favorites accept only known command ids and malformed storage is visible to callers", () => {
  assert.deepEqual([...parseGuideFavorites(JSON.stringify(["status", "status", "unknown"]))], ["status"]);
  assert.throws(() => parseGuideFavorites("{bad json"), /Unexpected token|JSON/);
  assert.throws(() => parseGuideFavorites(JSON.stringify(["status", 3])), /お気に入り/);
});
test("markdown exports selected commands with dynamic counts and safe fences", () => {
  const history = gitGuide.find((item) => item.id === "history");
  const path = "/tmp/a'b ``` $(secret)";
  const markdown = guideMarkdown([history], path, { log: 123, reflog: 20 });
  assert.match(markdown, /## 分岐と合流を見る/);
  assert.match(markdown, /直近123コミット/);
  assert.match(markdown, /````bash\n/);
  assert.match(markdown, /git -C '\/tmp\/a'\\'''?b ``` \$\(secret\)' log --graph --oneline --decorate --all -123/);
  assert.match(markdown, /\n````\n/);
});
test("snapshot preserves unknown values and only the supplied visible projects", () => {
  const snapshot = JSON.parse(workspaceSnapshot([{ name: "=test", main_path: null, remote: null, lane_count: null, worktree_count: 0, git: { dirty: 0 }, agent_state: null, agent_priority_counts: { active: null }, latest_event: null, latest_observed_at: 123 }], { query: "test" }, "2026-09-30T00:00:00Z"));
  assert.equal(snapshot.projects.length, 1);
  assert.equal(snapshot.projects[0].branches, null);
  assert.equal(snapshot.projects[0].agentCounts.active, null);
  assert.equal(snapshot.projects[0].name, "=test");
  assert.equal(snapshot.view.query, "test");
});

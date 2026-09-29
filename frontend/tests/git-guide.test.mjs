import test from "node:test";
import assert from "node:assert/strict";
import { gitGuide, guideMatches, guideCommand } from "../app/git-guide-data.mjs";
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
test("snapshot preserves unknown values and only the supplied visible projects", () => {
  const snapshot = JSON.parse(workspaceSnapshot([{ name: "=test", main_path: null, remote: null, lane_count: null, worktree_count: 0, git: { dirty: 0 }, agent_state: null, agent_priority_counts: { active: null }, latest_event: null, latest_observed_at: 123 }], { query: "test" }, "2026-09-30T00:00:00Z"));
  assert.equal(snapshot.projects.length, 1);
  assert.equal(snapshot.projects[0].branches, null);
  assert.equal(snapshot.projects[0].agentCounts.active, null);
  assert.equal(snapshot.projects[0].name, "=test");
  assert.equal(snapshot.view.query, "test");
});

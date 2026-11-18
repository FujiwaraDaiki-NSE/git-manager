import assert from "node:assert/strict";
import test from "node:test";
import { commandTarget, worktreeCommand } from "../app/next-command-tools.mjs";

test("次コマンドを選択したworktreeのパスに固定する", () => {
  for (const command of ["git add -p", "git commit", "git pull --ff-only"]) {
    assert.equal(worktreeCommand(command, "/tmp/my repo/日本語", "/tmp/main"), `git -C '/tmp/my repo/日本語' ${command.slice(4)}`);
  }
});

test("パス内のシングルクォートを既存のシェル形式でエスケープする", () => {
  assert.equal(worktreeCommand("git status", "/tmp/it's 日本語 repo", "/tmp/main"), "git -C '/tmp/it'\\''s 日本語 repo' status");
});

test("パスがnullなら元のコマンドを保持する", () => {
  assert.equal(worktreeCommand("git commit", null, "/tmp/main"), "git commit");
});

test("gitで始まらないコマンドを変更しない", () => {
  for (const command of ["cd '/tmp/repo'", "echo git status", "gitk", ""]) {
    assert.equal(worktreeCommand(command, "/tmp/日本語 repo", "/tmp/main"), command);
    assert.equal(worktreeCommand(command, null, null), command);
  }
});

test("git worktree の管理コマンドは削除済みworktreeではなくメインのチェックアウトで実行する", () => {
  assert.equal(worktreeCommand("git worktree prune", "/tmp/deleted wt", "/tmp/main"), "git -C '/tmp/main' worktree prune");
  assert.equal(worktreeCommand("git worktree remove /tmp/wt", "/tmp/wt", "/tmp/main"), "git -C '/tmp/main' worktree remove /tmp/wt");
  assert.equal(worktreeCommand("git worktree prune", "/tmp/wt", null), "git worktree prune");
  assert.equal(commandTarget("git worktree prune", "/tmp/wt", "/tmp/main"), "/tmp/main");
  assert.equal(commandTarget("git add -p", "/tmp/wt", "/tmp/main"), "/tmp/wt");
});

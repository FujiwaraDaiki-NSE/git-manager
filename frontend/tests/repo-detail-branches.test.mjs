import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import { shellQuote } from "../app/status-file-tools.mjs";
import { worktreeCommand } from "../app/next-command-tools.mjs";

const source = readFileSync(new URL("../app/repo-detail.tsx", import.meta.url), "utf8");
const rowSource = source.slice(source.indexOf("function BranchRow("), source.indexOf("function BranchesPane("));
const compiled = ts.transpileModule(`export ${rowSource}`, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } });
const module = { exports: {} };
new Function("require", "exports", "shellQuote", "worktreeCommand", compiled.outputText)(createRequire(import.meta.url), module.exports, shellQuote, worktreeCommand);
const { BranchRow } = module.exports;
const repo = { path: "/tmp/main's repo", common_dir: "/tmp/main" };
const branch = { name: "topic's", hash: "abc", current: false, merged: false, worktree: "/tmp/other", date: null };
const props = { repo, repos: new Map([[branch.worktree, {}]]), branch, onCopy: () => {}, onOpenWorktree: () => {} };
function buttons(element) {
  if (!element || typeof element !== "object") return [];
  if (Array.isArray(element)) return element.flatMap(buttons);
  return [...(element.type === "button" ? [element] : []), ...buttons(element.props?.children)];
}

test("worktree action passes the observed path, while current and unavailable worktrees explain their state", () => {
  let opened = null;
  const row = BranchRow({ ...props, onOpenWorktree: (path) => { opened = path; } });
  const action = buttons(row).find((button) => button.props.children === "このworktreeのGit詳細");
  action.props.onClick();
  assert.equal(opened, branch.worktree);
  const current = BranchRow({ ...props, branch: { ...branch, worktree: repo.path } });
  assert.match(renderToStaticMarkup(current), /表示中/);
  assert.equal(buttons(current).length, 0);
  const unavailable = BranchRow({ ...props, repos: new Map() });
  assert.match(renderToStaticMarkup(unavailable), /リポジトリ情報が未取得/);
  assert.equal(buttons(unavailable).length, 0);
});

test("only merged branches without a worktree offer deletion, quoting both the displayed path and branch", () => {
  let copied = null;
  const row = BranchRow({ ...props, branch: { ...branch, merged: true, worktree: null }, onCopy: (command) => { copied = command; } });
  buttons(row)[0].props.onClick();
  assert.equal(copied, "git -C '/tmp/main'\\''s repo' branch -d 'topic'\\''s'");
  assert.match(renderToStaticMarkup(row), /実行先/);
  for (const candidate of [branch, { ...branch, merged: true }, { ...branch, merged: true, current: true, worktree: null }]) {
    assert.ok(buttons(BranchRow({ ...props, branch: candidate })).every((button) => button.props.children !== "削除コマンドをコピー"));
  }
});

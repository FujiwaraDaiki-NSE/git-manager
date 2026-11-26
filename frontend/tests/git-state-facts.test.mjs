import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { worktreeCommand } from "../app/next-command-tools.mjs";

const source = readFileSync(new URL("../app/git-state-facts.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source.replace('import "./git-state-facts.css";', ""), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } });
const module = { exports: {} };
const baseRequire = createRequire(import.meta.url);
const CopyButton = ({ value, label }) => React.createElement("button", { type: "button", "aria-label": label, "data-value": value }, "コピー");
runInNewContext(compiled.outputText, { exports: module.exports, require: (id) => {
  if (id === "./copy-button") return { __esModule: true, default: CopyButton };
  if (id === "./next-command-tools.mjs") return { worktreeCommand };
  return baseRequire(id);
} });
const { FetchFacts, FetchFailureBreakdown, OperationFacts, DestinationFacts } = module.exports;
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));

test("fetch failure retains success time and displays category and stderr", () => {
  const html = render(FetchFacts, { fetchedAt: 10, status: { attempted_at: 20, result: "failure", category: "authentication", reason: "Permission denied" } });
  assert.match(html, /最後に成功したfetch/);
  assert.match(html, /直近の試行: 失敗/);
  assert.match(html, /認証 · Permission denied/);
  assert.match(render(FetchFacts, { fetchedAt: null, status: null }), /記録なし/);
});

test("fetch failure breakdown counts the supplied projects and keeps missing categories separate", () => {
  const project = (category, result = "failure") => ({ fetch_status: { result, category } });
  const projects = [project("authentication"), project("timeout"), project("timeout"), project("other"), project(null), project(null, "success")];
  assert.match(render(FetchFailureBreakdown, { projects }), /認証 1件 · タイムアウト 2件 · その他 1件 · 未取得 1件/);
  assert.match(render(FetchFailureBreakdown, { projects: projects.slice(1, 3) }), /内訳　タイムアウト 2件<\/p>/);
  assert.equal(render(FetchFailureBreakdown, { projects: [project(null, "success")] }), "");
});

test("operation progress and copyable commands render separately from unknown and absent operations", () => {
  const html = render(OperationFacts, { path: "/repo/topic", operations: [{ kind: "rebase", marker: "rebase-merge", step: 3, total: 7, commands: [{ command: "git rebase --continue", reason: "競合解消後に継続" }, { command: "git rebase --abort", reason: "中止" }] }] });
  assert.match(html, /rebase途中（3\/7）/);
  assert.match(html, /git -C &#x27;\/repo\/topic&#x27; rebase --continue/);
  assert.match(html, /git -C &#x27;\/repo\/topic&#x27; rebase --abort/);
  assert.equal((html.match(/>コピー<\/button>/g) ?? []).length, 2);
  assert.match(render(OperationFacts, { operations: null, path: null }), /未取得/);
  assert.match(render(OperationFacts, { operations: [], path: "/repo/topic" }), /進行中の操作なし/);
});

test("cherry-pick uses the observed checkout for both display and copy", () => {
  const operations = [{ kind: "cherry-pick", marker: "CHERRY_PICK_HEAD", step: null, total: null,
    commands: [{ command: "git cherry-pick --abort", reason: "中止" }],
    todo_first: { hash: "127430234e27867d689ae6c4bf6cb667a0a1fdd0", subject: "wip b3" } }];
  const path = "/repo/linked checkout";
  const html = render(OperationFacts, { operations, path });
  const command = "git -C &#x27;/repo/linked checkout&#x27; cherry-pick --abort";
  assert.ok(html.includes(`<code>${command}</code>`));
  assert.ok(html.includes(`data-value="${command}"`));
  assert.ok(html.includes(`実行先: ${path}`));
  assert.match(html, /todo先頭 <code>127430234e27867d689ae6c4bf6cb667a0a1fdd0<\/code> wip b3/);
  assert.doesNotMatch(render(OperationFacts, { operations: [{ ...operations[0], todo_first: null }], path }), /todo先頭/);
  const unknownPath = render(OperationFacts, { operations, path: null });
  assert.match(unknownPath, /実行先: 未取得/);
  assert.doesNotMatch(unknownPath, /data-value=/);
});

test("branch destinations show both push URLs and explain rejected push", () => {
  const html = render(DestinationFacts, { destinations: { fetch_remote: "origin", fetch_urls: ["https://example.test/read"], upstream: null, upstream_ref: "refs/heads/renamed", upstream_state: "configured", push_remote: "publish", push_remote_config: { selected_key: "branch.main.pushRemote", keys: [{ key: "branch.main.pushRemote", command: "git config --show-origin --show-scope --get-all branch.main.pushRemote", values: [{ value: "publish", scope: "local", origin: "file:.git/config" }] }] }, push_urls: ["ssh://one", "ssh://two"], push_ref: null, push_ref_reason: "simple: 名前が異なるためpushは拒否", push_refspecs: [], push_default: "simple" } });
  assert.match(html, /追跡参照なし/);
  assert.match(html, /<details><summary>push先の設定を調べる<\/summary>/);
  assert.match(html, /publish<\/code><strong> 採用<\/strong>/);
  assert.match(html, /local · <code>file:\.git\/config/);
  assert.match(html, /--show-origin --show-scope --get-all/);
  assert.match(html, /ssh:\/\/one \/ ssh:\/\/two/);
  assert.match(html, /名前が異なるためpushは拒否/);
  assert.match(render(DestinationFacts, { destinations: null }), /未取得/);
});

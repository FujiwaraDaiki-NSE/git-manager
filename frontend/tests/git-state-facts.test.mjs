import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const source = readFileSync(new URL("../app/git-state-facts.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source.replace('import "./git-state-facts.css";', ""), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } });
const module = { exports: {} };
const baseRequire = createRequire(import.meta.url);
const CopyButton = ({ value, label }) => React.createElement("button", { type: "button", "aria-label": label, "data-value": value }, "コピー");
runInNewContext(compiled.outputText, { exports: module.exports, require: (id) => id === "./copy-button" ? { __esModule: true, default: CopyButton } : baseRequire(id) });
const { FetchFacts, OperationFacts, DestinationFacts } = module.exports;
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));

test("fetch failure retains success time and displays category and stderr", () => {
  const html = render(FetchFacts, { fetchedAt: 10, status: { attempted_at: 20, result: "failure", category: "authentication", reason: "Permission denied" } });
  assert.match(html, /最後に成功したfetch/);
  assert.match(html, /直近の試行: 失敗/);
  assert.match(html, /認証 · Permission denied/);
  assert.match(render(FetchFacts, { fetchedAt: null, status: null }), /記録なし/);
});

test("operation progress and copyable commands render separately from unknown and absent operations", () => {
  const html = render(OperationFacts, { operations: [{ kind: "rebase", marker: "rebase-merge", step: 3, total: 7, commands: [{ command: "git rebase --continue", reason: "競合解消後に継続" }, { command: "git rebase --abort", reason: "中止" }] }] });
  assert.match(html, /rebase途中（3\/7）/);
  assert.match(html, /git rebase --continue/);
  assert.match(html, /git rebase --abort/);
  assert.equal((html.match(/>コピー<\/button>/g) ?? []).length, 2);
  assert.match(render(OperationFacts, { operations: null }), /未取得/);
  assert.match(render(OperationFacts, { operations: [] }), /進行中の操作なし/);
});

test("branch destinations show both push URLs and explain rejected push", () => {
  const html = render(DestinationFacts, { destinations: { fetch_remote: "origin", fetch_urls: ["https://example.test/read"], upstream: null, upstream_ref: "refs/heads/renamed", upstream_state: "configured", push_remote: "publish", push_urls: ["ssh://one", "ssh://two"], push_ref: null, push_ref_reason: "simple: 名前が異なるためpushは拒否", push_refspecs: [], push_default: "simple" } });
  assert.match(html, /追跡参照なし/);
  assert.match(html, /ssh:\/\/one \/ ssh:\/\/two/);
  assert.match(html, /名前が異なるためpushは拒否/);
  assert.match(render(DestinationFacts, { destinations: null }), /未取得/);
});

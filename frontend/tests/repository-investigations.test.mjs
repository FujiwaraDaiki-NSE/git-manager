import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

test("patch equivalence displays the compared refs and short SHAs with the reproduction command", () => {
  const left = "1234567890abcdef1234567890abcdef12345678";
  const right = "abcdef1234567890abcdef1234567890abcdef12";
  const command = `git log --cherry-mark --left-right ${left}...${right}`;
  const result = { left: "topic-a", right: "topic-b", left_sha: left, right_sha: right, command, commits: [] };
  const source = readFileSync(new URL("../app/repository-investigations.tsx", import.meta.url), "utf8").replace(/^import .*\.css";$/gm, "");
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } });
  const module = { exports: {} };
  const baseRequire = createRequire(import.meta.url);
  let state = 0;
  runInNewContext(compiled.outputText, {
    exports: module.exports,
    require: id => id === "react" ? { ...React, useState: initial => [state++ === 1 ? result : initial, () => {}] }
      : id.startsWith("./") ? { __esModule: true, default: () => null } : baseRequire(id),
  });
  const html = renderToStaticMarkup(React.createElement(module.exports.PatchEquivalence, { path: "/repo" }));
  assert.match(html, /A: topic-a @ 1234567890ab ／ B: topic-b @ abcdef123456/);
  assert.ok(html.includes(command));
  assert.match(html, /パッチ同等＝安全な重複とは限りません/);
});

test("commit search pages send large SHA arrays in POST bodies and refresh with GET", async () => {
  const shas = Array.from({ length: 1800 }, (_, i) => i.toString(16).padStart(40, "0"));
  const fields = { scope: "--all", grep: "needle", author: "", since: "", until: "", file: "" };
  const result = { commits: [], offset: 0, has_more: true, fixed_shas: shas };
  const source = readFileSync(new URL("../app/repository-investigations.tsx", import.meta.url), "utf8").replace(/^import .*\.css";$/gm, "");
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } });
  const module = { exports: {} };
  const baseRequire = createRequire(import.meta.url);
  const calls = [];
  let state = 0;
  runInNewContext(compiled.outputText, {
    exports: module.exports, URLSearchParams, AbortController,
    fetch: async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => result }; },
    require: id => id === "react" ? { ...React, useId: () => "test", useEffect: () => {}, useRef: () => ({ current: null }),
      useState: initial => [[fields, result, fields, null, false, null][state++], () => {}] }
      : id.startsWith("./") ? { __esModule: true, default: () => null } : baseRequire(id),
  });
  const outer = module.exports.CommitSearch({ path: "/repo" });
  const tree = outer.type(outer.props);
  const buttons = [];
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "button") buttons.push(node);
    React.Children.forEach(node.props?.children, visit);
  }
  visit(tree);
  buttons.find(button => button.props.children === "次の50件").props.onClick();
  await Promise.resolve();
  assert.equal(calls[0].url, "/api/repo/commit-search");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.fixed_shas, shas);
  assert.equal(body.offset, 50);
  assert.equal(body.grep, "needle");
  buttons.find(button => button.props.children === "最新状態で検索し直す").props.onClick();
  await Promise.resolve();
  assert.match(calls[1].url, /^\/api\/repo\/commit-search\?/);
  assert.ok(!calls[1].url.includes("fixed_shas"));
  assert.equal(new URLSearchParams(calls[1].url.split("?")[1]).get("offset"), "0");
  assert.equal(calls[1].init.method, undefined);
});

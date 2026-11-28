import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as status from "../app/submodule-status.mjs";
import * as projectFlow from "../app/project-flow.mjs";
import * as repositoryFilesTools from "../app/repository-files-tools.mjs";

test("repo更新で再取得し、取得中の表示保持・失敗表示・成功後の回復を行う", async () => {
  const values = [];
  const requests = [];
  let cursor = 0, previousDeps, cleanup;
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in values)) values[index] = initial;
      return [values[index], (value) => { values[index] = value; }];
    },
    useEffect(effect, deps) {
      if (!previousDeps || deps.some((value, index) => value !== previousDeps[index])) {
        cleanup?.();
        previousDeps = deps;
        cleanup = effect();
      }
    },
  };
  const compiled = ts.transpileModule(readFileSync(new URL("../app/submodules.tsx", import.meta.url), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  });
  const module = { exports: {} }, baseRequire = createRequire(import.meta.url);
  runInNewContext(compiled.outputText, {
    exports: module.exports, AbortController, URLSearchParams,
    window: { location: { href: "http://localhost/project?path=%2Frepo&tab=flow&gitPath=%2Frepo&gitTab=status&home=q%3Dgit&range=24h&investigation=compare&investigationBase=main" } },
    require(id) {
      if (id === "react") return hooks;
      if (id === "./submodule-status.mjs") return status;
      if (id === "./project-flow.mjs") return projectFlow;
      if (id === "./repository-files-tools.mjs") return repositoryFilesTools;
      if (id === "./copy-button") return { default: () => null, __esModule: true };
      return baseRequire(id);
    },
    fetch: (_url, options) => new Promise((resolve) => { requests.push({ resolve, signal: options.signal }); }),
  });
  let element;
  const render = (repo) => { cursor = 0; element = module.exports.default({ repo }); return renderToStaticMarkup(element); };
  const respond = async (ok, state = "same") => {
    requests.at(-1).resolve({ ok, status: ok ? 200 : 502, json: async () => ({ submodules: [{
      path: "lib", recorded_commit: "a".repeat(40), checkout_commit: state === "uninitialized" ? null : "a".repeat(40), status: state,
    }] }) });
    await new Promise(setImmediate);
  };
  const parentHead = "b".repeat(40);
  let repo = { path: "/repo", head: parentHead };
  assert.equal(render(repo), "");
  await respond(false);
  assert.match(render(repo), /取得できませんでした/);
  assert.match(render(repo), /再取得/);
  element.props.children[1].props.onClick();
  render(repo);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].signal.aborted, true);
  await respond(true, "uninitialized");
  const before = render(repo);
  assert.match(before, /未初期化/);
  assert.match(before, /現在のチェックアウト <code>未確定<\/code>/);
  assert.doesNotMatch(before, /取得できませんでした/);
  const historyHref = before.match(/href="([^"]+)">親での参照更新履歴<\/a>/)[1].replaceAll("&amp;", "&");
  const history = new URL(historyHref, "http://localhost");
  assert.equal(history.pathname, "/project");
  assert.deepEqual(Object.fromEntries(history.searchParams), {
    path: "/repo",
    tab: "info",
    home: "q=git",
    range: "24h",
    investigation: "file-history",
    investigationRevision: parentHead,
    investigationFile: "lib",
    investigationFollow: "false",
  });
  assert.doesNotMatch(render({ ...repo, head: null }), /親での参照更新履歴/);
  repo = { ...repo };
  render(repo);
  assert.match(render(repo), /更新中（前回の結果を表示）/);
  assert.match(render(repo), /未初期化/);
  await respond(true);
  assert.match(render(repo), /一致/);
  assert.match(render(repo), /親のindex <code>a{40}<\/code>.*現在のチェックアウト <code>a{40}<\/code>/);
  assert.doesNotMatch(render(repo), /未初期化/);
  assert.equal(requests.length, 4);
  repo = { ...repo };
  render(repo);
  requests.at(-1).resolve({ ok: true, json: async () => ({ submodules: [] }) });
  await new Promise(setImmediate);
  assert.equal(render(repo), "");
  repo = { ...repo };
  render(repo);
  assert.equal(render(repo), "");
  cleanup();
});

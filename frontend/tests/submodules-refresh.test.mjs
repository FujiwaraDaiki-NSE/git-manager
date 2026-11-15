import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as status from "../app/submodule-status.mjs";

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
    require: (id) => id === "react" ? hooks : id === "./submodule-status.mjs" ? status : id === "./copy-button" ? { default: () => null, __esModule: true } : baseRequire(id),
    fetch: (_url, options) => new Promise((resolve) => { requests.push({ resolve, signal: options.signal }); }),
  });
  const render = (repo) => { cursor = 0; return renderToStaticMarkup(module.exports.default({ repo })); };
  const respond = async (ok, state = "same") => {
    requests.at(-1).resolve({ ok, status: ok ? 200 : 502, json: async () => ({ submodules: [{ path: "lib", recorded_commit: "a".repeat(40), status: state }] }) });
    await new Promise(setImmediate);
  };
  let repo = { path: "/repo" };
  assert.equal(render(repo), "");
  await respond(false);
  assert.match(render(repo), /取得できませんでした/);
  repo = { ...repo };
  render(repo);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].signal.aborted, true);
  await respond(true, "uninitialized");
  const before = render(repo);
  assert.match(before, /未初期化/);
  assert.doesNotMatch(before, /取得できませんでした/);
  repo = { ...repo };
  assert.equal(render(repo), before);
  await respond(true);
  assert.match(render(repo), /一致/);
  assert.doesNotMatch(render(repo), /未初期化/);
  assert.equal(requests.length, 3);
  cleanup();
});

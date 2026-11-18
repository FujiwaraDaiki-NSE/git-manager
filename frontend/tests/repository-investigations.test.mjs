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

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

test("Git detail exposes the conflict inspector for the selected worktree only when status confirms a conflict", () => {
  const source = new URL("../app/repo-detail.tsx", import.meta.url);
  const compiled = ts.transpileModule(readFileSync(source, "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  });
  const requireApp = createRequire(source);
  const module = { exports: {} };
  new Function("require", "exports", compiled.outputText)((id) => {
    if (id === "./conflict-inspector") {
      return { default: ({ path }) => createElement("div", { "data-conflict-repo": path }) };
    }
    if (id === "./status") return { codeColor: () => undefined, stateBadges: () => [] };
    if (id === "./git-state-facts") return { OperationFacts: () => null };
    if (id.startsWith("./") && !id.endsWith(".mjs")) return { default: () => null };
    return requireApp(id);
  }, module.exports);

  const repo = { path: "/linked", common_dir: "/main", entries: [{ xy: "UU", path: "file", original_path: null }] };
  const render = (repo) => renderToStaticMarkup(createElement(module.exports.default, { repo, activeTab: "status" }));
  assert.match(render(repo), /data-conflict-repo="\/linked"/);
  assert.doesNotMatch(render({ ...repo, entries: [] }), /data-conflict-repo/);
  assert.doesNotMatch(render({ ...repo, error: "git status を実行できませんでした" }), /data-conflict-repo/);
});

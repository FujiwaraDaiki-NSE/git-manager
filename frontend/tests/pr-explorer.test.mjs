import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as prTools from "../app/pr-tools.mjs";

const source = readFileSync(new URL("../app/pr-explorer.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
});
const exports = {};
const require = createRequire(import.meta.url);
runInNewContext(compiled.outputText, {
  exports,
  require(id) {
    if (id === "./pr-tools.mjs") return prTools;
    if (id === "./scroll-shadow" || id === "./copy-button") return {};
    return require(id);
  },
});

test("オープンPRの取得結果から件数と照会時刻を表示する", () => {
  const checkedAt = Date.parse("2026-10-02T00:00:00Z") / 1000;
  const render = (open) => renderToStaticMarkup(createElement(exports.default, {
    project: {
      branch_rows: [],
      observed_at: checkedAt + 7200,
      github: { status: "available", checked_at: checkedAt + 3600, open },
    },
  }));
  const open = { status: "available", reason: null, checked_at: checkedAt };
  const passingPr = { number: 1, ciState: "SUCCESS", reviewDecision: "APPROVED" };
  const failingPr = { number: 2, url: "https://github.com/example/repo/pull/2", ciState: "FAILURE" };

  assert.match(render({ ...open, pulls: [] }), /オープンPR 0件中、CI失敗・変更要求 0件/);
  const withNoMatches = render({ ...open, pulls: [passingPr, { ...passingPr, number: 2 }] });
  assert.match(withNoMatches, /オープンPR 2件中、CI失敗・変更要求 0件 · 照会時刻 <time dateTime="2026-10-02T00:00:00.000Z">/);
  const withMatch = render({ ...open, pulls: [passingPr, failingPr] });
  assert.match(withMatch, /オープンPR 2件中、CI失敗・変更要求 1件/);
  assert.match(withMatch, /<a href="https:\/\/github.com\/example\/repo\/pull\/2"[^>]+>PR #2/);

  const notApplicable = render({ status: "not_applicable", reason: "GitHubのoriginがありません", checked_at: null, pulls: [] });
  assert.match(notApplicable, /オープンPR情報は対象外です/);
  assert.doesNotMatch(notApplicable, /件中|照会時刻/);
});

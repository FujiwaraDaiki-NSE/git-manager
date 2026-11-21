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
  const passingPr = {
    number: 1, url: "https://github.com/example/repo/pull/1", title: "確認済み",
    headRefName: "ready", baseRefName: "main", isDraft: false,
    ciState: "SUCCESS", reviewDecision: "APPROVED",
  };
  const failingPr = { ...passingPr, number: 2, url: "https://github.com/example/repo/pull/2", title: "CI修正", ciState: "FAILURE" };
  const reviewPr = { ...passingPr, number: 3, url: "https://github.com/example/repo/pull/3", title: "レビュー依頼", reviewDecision: "REVIEW_REQUIRED" };
  const draftPr = { ...passingPr, number: 4, url: "https://github.com/example/repo/pull/4", title: "下書き", isDraft: true, reviewDecision: null, ciState: null };

  const empty = render({ ...open, pulls: [] });
  assert.match(empty, /オープンPR 0件中、CI失敗・変更要求 0件/);
  assert.match(empty, /すべてのオープンPR（0件）.*オープンPRはありません/);
  const withNoMatches = render({ ...open, pulls: [passingPr, reviewPr] });
  assert.match(withNoMatches, /オープンPR 2件中、CI失敗・変更要求 0件 · 照会時刻 <time dateTime="2026-10-02T00:00:00.000Z">/);
  const withMatch = render({ ...open, pulls: [passingPr, failingPr, reviewPr, draftPr, draftPr] });
  assert.match(withMatch, /オープンPR 4件中、CI失敗・変更要求 1件/);
  const [attention, all] = withMatch.split("<details>");
  const prNumbers = (html) => html.match(/PR #\d+/g);
  assert.deepEqual(prNumbers(attention), ["PR #2"]);
  assert.deepEqual(prNumbers(all), ["PR #1", "PR #2", "PR #3", "PR #4"]);
  assert.match(all, /すべてのオープンPR（4件）.*確認済み.*<code>ready<\/code> → <code>main<\/code>.*レビュー承認 · CI 成功/);
  assert.match(all, /レビュー待ち.*Draft/);

  const unavailable = render({ status: "unavailable", reason: "取得失敗", checked_at: null, pulls: [] });
  assert.match(unavailable, /オープンPRを取得できませんでした/);
  assert.doesNotMatch(unavailable, /すべてのオープンPR|オープンPRはありません/);

  const notApplicable = render({ status: "not_applicable", reason: "GitHubのoriginがありません", checked_at: null, pulls: [] });
  assert.match(notApplicable, /オープンPR情報は対象外です/);
  assert.doesNotMatch(notApplicable, /件中|照会時刻/);
});

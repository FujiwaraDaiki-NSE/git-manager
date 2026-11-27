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
  const fields = { scope: "--all", mode: "message", grep: "needle", author: "", since: "", until: "", file: "" };
  const submitted = { ...fields, mode: "diff-regex", since_at: "", until_at: "" };
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
      useState: initial => [[fields, result, submitted, null, false, null][state++], () => {}] }
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
  const html = renderToStaticMarkup(tree);
  assert.match(html, /option value="content".*git log -S/);
  assert.match(html, /option value="diff-regex".*git log -G/);
  assert.match(html, /適用した条件: 追加・削除行を正規表現で検索（git log -G）「needle」/);
  buttons.find(button => button.props.children === "次の50件").props.onClick();
  await Promise.resolve();
  assert.equal(calls[0].url, "/api/repo/commit-search");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.fixed_shas, shas);
  assert.equal(body.offset, 50);
  assert.equal(body.grep, "needle");
  assert.equal(body.mode, "diff-regex");
  buttons.find(button => button.props.children === "最新状態で検索し直す").props.onClick();
  await Promise.resolve();
  assert.match(calls[1].url, /^\/api\/repo\/commit-search\?/);
  assert.ok(!calls[1].url.includes("fixed_shas"));
  const params = new URLSearchParams(calls[1].url.split("?")[1]);
  assert.equal(params.get("offset"), "0");
  assert.equal(params.get("mode"), "diff-regex");
  assert.equal(calls[1].init.method, undefined);
});

async function investigationHarness(kind, initial, fetchResult, props = {}) {
  const { fileStatusDescription } = await import("../app/file-status.mjs");
  const agentOverview = await import("../app/agent-overview.mjs");
  const source = readFileSync(new URL("../app/repository-investigations.tsx", import.meta.url), "utf8").replace(/^import .*\.css";$/gm, "");
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } });
  const module = { exports: {} };
  const baseRequire = createRequire(import.meta.url);
  const states = [...initial];
  const calls = [];
  let cursor = 0;
  runInNewContext(compiled.outputText, {
    exports: module.exports, URLSearchParams, AbortController,
    fetch: async (...args) => { calls.push(args); return fetchResult(); },
    require: id => id === "react" ? { ...React, useId: () => "test", useEffect: () => {}, useRef: () => ({ current: null }),
      useState: value => { const index = cursor++; if (!(index in states)) states[index] = value; return [states[index], next => { states[index] = next; }]; } }
      : id === "./file-status.mjs" ? { fileStatusDescription }
      : id === "./agent-overview.mjs" ? agentOverview
      : id.startsWith("./") ? { __esModule: true, default: () => null } : baseRequire(id),
  });
  function render() {
    cursor = 0;
    const outer = module.exports[kind]({ path: "/repo", ...props });
    return outer.type(outer.props);
  }
  function nodes(tree, type) {
    const found = [];
    function visit(node) {
      if (!node || typeof node !== "object") return;
      if (node.type === type) found.push(node);
      React.Children.forEach(node.props?.children, visit);
    }
    visit(tree);
    return found;
  }
  return { render, nodes, calls, states, html: () => renderToStaticMarkup(render()) };
}
const searchFields = { scope: "--all", mode: "message", grep: "", author: "", since: "", until: "", file: "" };

test("diff regex input errors appear in the existing search alert", async () => {
  const detail = "正規表現を確認してください";
  const h = await investigationHarness("CommitSearch", [{ ...searchFields, mode: "diff-regex", grep: "[" }],
    async () => ({ ok: false, status: 422, json: async () => ({ detail }) }));
  h.nodes(h.render(), "form")[0].props.onSubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(h.html(), /role="alert">[^<]*正規表現を確認してください/);
});

test("search results display both timestamps in the browser timezone and preserve their ISO values", async () => {
  const originalZone = process.env.TZ;
  try {
    process.env.TZ = "Asia/Tokyo";
    const date = "2026-01-02T10:33:43+00:00";
    const committer_date = "2026-01-02T05:40:38-05:00";
    const result = { commits: [{ hash: "abc", subject: "commit", date, committer_date, author: "author" }], offset: 0 };
    const h = await investigationHarness("CommitSearch", [searchFields, result, searchFields, null, false, "abc"]);
    const times = h.nodes(h.render(), "time");
    assert.deepEqual(times.map(t => [t.props.dateTime, t.props.children]), [
      [committer_date, "2026/1/2 19:40:38 JST"],
      [date, "2026/1/2 19:33:43 JST"],
    ]);
    const html = h.html();
    assert.match(html, /期間判定に使うコミッター日時 <time/);
    assert.ok(html.includes(`>${committer_date}</time>`));
    assert.ok(html.includes(`>${date}</time>`));
  } finally {
    if (originalZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalZone;
  }
});

test("selected message search result shows the full body only when it has text", async () => {
  const body = "背景の段落\n\n検索語を含む段落\n  続き";
  for (const value of [body, ""]) {
    const commit = { hash: "abc", subject: "件名", date: "2026-01-01", author: "author", body: value };
    const h = await investigationHarness("CommitSearch", [searchFields, { commits: [commit], offset: 0 }, searchFields, null, false, "abc"]);
    const html = h.html();
    assert.equal(html.includes("repository-investigation-commit-body"), value !== "");
    if (value !== "") assert.ok(html.includes(`>${body}</p>`));
  }
});

test("date validation describes both date inputs and blocks only reversed ranges", async () => {
  for (const [since, until, invalid] of [["2026-02-02", "2026-02-01", true], ["2026-02-01", "2026-02-01", false], ["2026-02-01", "", false], ["", "2026-02-01", false], ["", "", false]]) {
    const h = await investigationHarness("CommitSearch", [{ ...searchFields, since, until }, null, null, null, false, null], async () => ({ ok: true, json: async () => ({ commits: [], offset: 0 }) }));
    const tree = h.render();
    assert.equal(h.html().includes("開始日は終了日以前の日付にしてください"), invalid);
    for (const input of h.nodes(tree, "input").filter(n => n.props.type === "date")) {
      assert.equal(input.props["aria-invalid"], invalid ? true : undefined);
      assert.equal(input.props["aria-describedby"], invalid ? "test-date-error" : undefined);
    }
    h.nodes(tree, "form")[0].props.onSubmit({ preventDefault() {} });
    assert.equal(h.calls.length, invalid ? 0 : 1);
  }
});

test("search uses local date boundaries and keeps the submitted instants when paging", async () => {
  const originalZone = process.env.TZ;
  try {
    for (const [zone, date, since, until] of [
      ["America/New_York", "2026-07-01", "2026-07-01T04:00:00.000Z", "2026-07-02T03:59:59.000Z"],
      ["America/New_York", "2026-03-08", "2026-03-08T05:00:00.000Z", "2026-03-09T03:59:59.000Z"],
      ["America/New_York", "2026-11-01", "2026-11-01T04:00:00.000Z", "2026-11-02T04:59:59.000Z"],
      ["Asia/Tokyo", "2026-01-02", "2026-01-01T15:00:00.000Z", "2026-01-02T14:59:59.000Z"],
    ]) {
      process.env.TZ = zone;
      const fields = { ...searchFields, since: date, until: date };
      const result = { commits: [], offset: 0, has_more: true, fixed_shas: [] };
      const h = await investigationHarness("CommitSearch", [fields], async () => ({ ok: true, json: async () => result }));
      h.nodes(h.render(), "form")[0].props.onSubmit({ preventDefault() {} });
      await new Promise(resolve => setImmediate(resolve));
      const params = new URLSearchParams(h.calls[0][0].split("?")[1]);
      assert.equal(params.get("since_at"), since);
      assert.equal(params.get("until_at"), until);

      process.env.TZ = "UTC";
      h.nodes(h.render(), "button").find(n => n.props.children === "次の50件").props.onClick();
      const body = JSON.parse(h.calls[1][1].body);
      assert.equal(body.since_at, since);
      assert.equal(body.until_at, until);
    }
  } finally {
    if (originalZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalZone;
  }
});

test("paging preserves results and controls while busy and after failure; new search clears them", async () => {
  let reject;
  const h = await investigationHarness("CommitSearch", [searchFields, { commits: [{ hash: "abc", subject: "表示中", date: "2026-01-01", author: "author" }], offset: 50, has_more: true, fixed_shas: [] }, searchFields, null, false, null], () => new Promise((_, fail) => { reject = fail; }));
  for (const label of ["次の50件", "前の50件"]) {
    h.nodes(h.render(), "button").find(n => n.props.children === label).props.onClick();
    assert.match(h.html(), /表示中/);
    assert.match(h.html(), /aria-busy="true"/);
    assert.ok(h.html().includes(`${label}を取得中…`));
    assert.ok(h.nodes(h.render(), "button").filter(n => ["次の50件", "前の50件"].includes(n.props.children)).every(n => n.props.disabled));
    reject(new Error("ページ取得失敗"));
    await new Promise(resolve => setImmediate(resolve));
    assert.match(h.html(), /表示中/);
    assert.match(h.html(), /取得できませんでした。Error: ページ取得失敗/);
    assert.match(h.html(), /aria-busy="false"/);
  }
  h.nodes(h.render(), "form")[0].props.onSubmit({ preventDefault() {} });
  assert.ok(!h.html().includes("表示中"));
});

test("search ranges use returned length and distinguish empty first and later pages", async () => {
  for (const [offset, commits, expected] of [[50, Array.from({ length: 13 }, (_, i) => ({ hash: String(i), subject: "commit", date: "2026-01-01", author: "author" })), "51〜63件目を表示"], [0, [], "検索結果0件"], [50, [], "このページに該当するコミットはありません"]]) {
    const h = await investigationHarness("CommitSearch", [searchFields, { scope: "--all", commits, offset }, searchFields, null, false, null]);
    assert.ok(h.html().includes(expected));
    assert.ok(!h.html().includes("件目から"));
  }
});

test("overlaps retain XY codes and caution alongside shared Japanese status descriptions", async () => {
  const worktrees = [
    { worktree: "/repo0", branch: "refs/heads/topic", xy: ["M ", " M", "??"] },
    { worktree: "/repo1", branch: "refs/heads/topic", xy: ["UU"] },
  ];
  const opened = [];
  const h = await investigationHarness("WorktreeOverlaps", [searchFields, { overlaps: [{ path: "file", worktrees }] }], undefined, { agentTasks: null, onOpenWorktree: path => opened.push(path) });
  const html = h.html();
  for (const text of ["M ", " M", "??", "UU", "ステージ: 変更", "作業: 変更", "未追跡", "双方で変更", "同じパスを変更中でも、競合するとは限りません。各worktreeを順に観測した結果です。"]) assert.ok(html.includes(text));
  const rows = h.nodes(h.render(), "li").filter(node => node.props.className === "tag-explorer-commit-meta");
  assert.equal(rows.length, 2);
  assert.match(renderToStaticMarkup(rows[0]), /\/repo0.*ステージ: 変更.*作業: 変更.*未追跡/);
  for (const row of rows) {
    const openButton = h.nodes(row, "button").find(node => node.props.children === "このworktreeの状態を開く");
    openButton.props.onClick();
  }
  assert.deepEqual(opened, ["/repo0", "/repo1"]);
});

test("overlaps show each explicit report by exact branch name, including its own question and time", async () => {
  const worktrees = [
    { worktree: "/repo", branch: "refs/heads/main", xy: [" M"] },
    { worktree: "/topic", branch: "refs/heads/feature/topic", xy: [" M"] },
    { worktree: "/no-report", branch: "refs/heads/feature", xy: [" M"] },
    { worktree: "/detached", branch: null, xy: [" M"] },
  ];
  const agentTasks = [
    { branch: "main", worktree: "/old-checkout", kind: "status", status: "implementing", summary: "実装作業", decision: null, occurred_at: "2026-01-01T01:00:00Z" },
    { branch: "feature/topic", kind: "status", status: "waiting_for_user", summary: "確認作業", decision: { question: "仕様を確定しますか？" }, occurred_at: "2026-01-01T02:00:00Z" },
    { branch: "feature", kind: "lifecycle", summary: "ライフサイクル" },
    { branch: null, kind: "status", status: "testing", summary: "紐付けなし" },
  ];
  const h = await investigationHarness("WorktreeOverlaps", [searchFields, { overlaps: [{ path: "file", worktrees }] }], undefined, { agentTasks, onOpenWorktree() {} });
  const rows = h.nodes(h.render(), "li").filter(node => node.props.className === "tag-explorer-commit-meta").map(renderToStaticMarkup);
  assert.match(rows[0], /実装中.*実装作業.*dateTime="2026-01-01T01:00:00Z"/);
  assert.doesNotMatch(rows[0], /仕様を確定しますか/);
  assert.match(rows[1], /feature\/topic.*入力待ち.*確認作業.*仕様を確定しますか.*dateTime="2026-01-01T02:00:00Z"/);
  assert.doesNotMatch(rows[2], /agent報告|ライフサイクル/);
  assert.match(rows[3], /detached HEAD/);
  assert.doesNotMatch(rows[3], /agent報告|紐付けなし/);
});

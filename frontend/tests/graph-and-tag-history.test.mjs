import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as branchRelation from "../app/branch-relation.mjs";
import * as investigationPresets from "../app/investigation-presets-tools.mjs";
import * as reflogTools from "../app/reflog-explorer-tools.mjs";
import * as reflogInvestigation from "../app/reflog-investigation-tools.mjs";
import * as tagTools from "../app/tag-explorer-tools.mjs";
import * as tagInvestigation from "../app/tag-investigation-tools.mjs";

function componentHarness(filename, dependencies, fetch, window) {
  const source = new URL(`../app/${filename}`, import.meta.url);
  const require = createRequire(source);
  const compiled = ts.transpileModule(readFileSync(source, "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  });
  const exports = {};
  const state = [];
  let cursor = 0;
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in state)) state[index] = initial;
      return [state[index], (value) => { state[index] = value; }];
    },
    useEffect() {},
    useMemo: (compute) => compute(),
    useCallback: (callback) => callback,
    useRef(current) {
      const index = cursor++;
      if (!(index in state)) state[index] = { current };
      return state[index];
    },
  };
  new Function("require", "exports", "fetch", "window", compiled.outputText)((id) => {
    if (id === "react") return hooks;
    if (id.endsWith(".css")) return {};
    return dependencies[id] ?? require(id);
  }, exports, fetch, window);
  return (props) => {
    cursor = 0;
    return exports.default(props);
  };
}

function findNode(tree, predicate) {
  let found;
  function visit(node) {
    if (found || !React.isValidElement(node)) return;
    if (predicate(node)) found = node;
    else React.Children.forEach(node.props.children, visit);
  }
  visit(tree);
  return found;
}

test("graph marks the visible first-parent history in place and extends it when more rows arrive", () => {
  const graphView = componentHarness("graph-view.tsx", { "./branch-relation.mjs": branchRelation });
  const row = (hash, parents, is_head = false) => ({
    hash, parents, is_head, short: hash, subject: hash, refs: [], lane: 0,
    through: [], in_lanes: [], out_lanes: [], is_merge: parents.length > 1,
  });
  const rows = [row("side", []), row("head", ["first", "side"], true), row("first", ["root"])];
  const render = (visible) => graphView({ rows: visible, maxLane: 1, virtualNode: { lane: 1, label: "未コミット" } });
  const marked = (html) => Array.from(html.matchAll(/class="[^"]*graph-row-first-parent[^"]*" id="graph-row-([^"]+)"/g), (match) => match[1]);
  assert.deepEqual(marked(renderToStaticMarkup(render(rows))), []);

  const toggle = findNode(render(rows), (node) => node.type === "input");
  toggle.props.onChange({ target: { checked: true } });
  const limited = renderToStaticMarkup(render(rows));
  assert.deepEqual(marked(limited), ["head", "first"]);
  assert.match(limited, /2件（取得範囲の端）/);
  assert.deepEqual(Array.from(limited.matchAll(/id="graph-row-([^"]+)"/g), (match) => match[1]), ["virtual", "side", "head", "first"]);

  const expanded = renderToStaticMarkup(render([...rows, row("root", [])]));
  assert.deepEqual(marked(expanded), ["head", "first", "root"]);
  assert.doesNotMatch(expanded, /取得範囲の端/);
  assert.match(renderToStaticMarkup(render([rows[0]])), /取得範囲にHEADがありません/);
});

test("graph navigates to each loaded child, including a merge's second-parent link", (t) => {
  const graphView = componentHarness("graph-view.tsx", { "./branch-relation.mjs": branchRelation });
  const row = (hash, short, subject, parents) => ({
    hash, short, subject, parents, refs: [], lane: 0,
    through: [], in_lanes: [], out_lanes: [], is_merge: parents.length > 1,
  });
  const parent = row("parent-full", "parent", "Root commit", []);
  const first = row("first-full", "first", "Change on first branch", [parent.hash]);
  const merge = row("merge-full", "merge", "Merge another branch", ["outside", parent.hash]);
  const unrelated = row("other-full", "other", "Unrelated commit", ["outside"]);
  const rows = [first, merge, unrelated, parent];
  const selected = [];
  const focused = [];
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    getElementById: (id) => ({ focus: () => focused.push(id) }),
  } });
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else delete globalThis.document;
  });

  const render = (selectedHash) => graphView({ rows, maxLane: 0, selectedHash, onSelect: (hash) => selected.push(hash) });
  const childGroup = (hash) => findNode(render(hash), (node) => node.props["aria-label"] === "子コミットへ移動");
  const buttons = React.Children.toArray(childGroup(parent.hash).props.children);
  assert.deepEqual(buttons.map((button) => button.props.children.join("")), [
    "子（first）Change on first branch へ移動",
    "子（merge）Merge another branch へ移動",
  ]);
  for (const button of buttons) button.props.onClick();
  assert.deepEqual(selected, [first.hash, merge.hash]);
  assert.deepEqual(focused, [`graph-row-${first.hash}`, `graph-row-${merge.hash}`]);
  assert.match(renderToStaticMarkup(childGroup(first.hash)), /取得範囲内に子コミットはありません/);
});

test("graph jumps to a unique SHA prefix and waits for a choice on multiple matches", (t) => {
  const graphView = componentHarness("graph-view.tsx", { "./branch-relation.mjs": branchRelation });
  const row = (hash) => ({
    hash, short: hash.slice(0, 7), subject: hash, parents: [], refs: [], lane: 0,
    through: [], in_lanes: [], out_lanes: [], is_merge: false,
  });
  const rows = [row("c154700" + "a".repeat(33)), row("c156911" + "b".repeat(33))];
  const selected = [];
  const focused = [];
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    getElementById: (id) => ({ focus: () => focused.push(id) }),
  } });
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else delete globalThis.document;
  });
  const render = () => graphView({ rows, maxLane: 0, onSelect: (hash) => selected.push(hash) });
  const search = (value) => {
    findNode(render(), (node) => node.props.type === "search").props.onChange({ target: { value } });
    findNode(render(), (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  };

  search(" C154700 ");
  assert.deepEqual(selected, [rows[0].hash]);
  search("c15");
  const choices = findNode(render(), (node) => node.props["aria-label"] === "SHAの移動先候補");
  assert.equal(choices.props.children.length, 2);
  assert.deepEqual(selected, [rows[0].hash]);
  choices.props.children[1].props.children.props.onClick();
  assert.deepEqual(selected, rows.map((item) => item.hash));
  assert.deepEqual(focused, rows.map((item) => `graph-row-${item.hash}`));

  search("e1fc8b8");
  assert.match(renderToStaticMarkup(render()), /現在の取得範囲（2件）にありません/);
  assert.equal(selected.length, 2);
});

test("reflog comparison uses the explicitly chosen rows across filters and clears on ref change", async () => {
  const path = "/repos/gitdash";
  const current = new URL("http://localhost/project?tab=info&range=30d&home=%2F%3Fq%3Dgit&investigation=compare&investigationBase=old#reflog");
  current.searchParams.set("path", path);
  const base = { hash: "a".repeat(40), selector: "HEAD@{1}", message: "commit: change", actor: null, date: null };
  const target = { ...base, hash: "b".repeat(40), selector: "HEAD@{0}", message: "reset: moving to HEAD~1" };
  const reflogExplorer = componentHarness("reflog-explorer.tsx", {
    "./commit-files": { default: () => null },
    "./copy-button": { default: () => null },
    "./patch-view": { default: () => null },
    "./investigation-presets-tools.mjs": investigationPresets,
    "./reflog-explorer-tools.mjs": reflogTools,
    "./reflog-investigation-tools.mjs": reflogInvestigation,
  }, async () => ({ ok: true, json: async () => ({ ref: "HEAD", records: [target, base], available: true, truncated: false }) }), { location: current });
  const find = (predicate) => findNode(reflogExplorer({ path }), predicate);
  const change = (label, value) => find((node) => node.props["aria-label"] === label).props.onChange({ target: { value } });
  const button = (label) => find((node) => node.type === "button" && node.props.children === label);
  const link = () => find((node) => node.type === "a" && node.props.children === "直接比較を開く");
  change("reflogを調べるref", "HEAD");
  button("このrefを調査").props.onClick();
  await setImmediate();

  change("reflogを検索", base.hash);
  button("比較元").props.onClick();
  assert.equal(button("比較先").props.disabled, true);
  assert.equal(link(), undefined);
  change("reflogを検索", target.hash);
  button("カード").props.onClick();
  button("比較先").props.onClick();

  const url = new URL(link().props.href, "http://localhost");
  assert.equal(url.pathname, "/project");
  assert.equal(url.hash, "#commit-compare");
  assert.equal(url.searchParams.get("path"), path);
  assert.equal(url.searchParams.get("tab"), "info");
  assert.equal(url.searchParams.get("range"), "30d");
  assert.equal(url.searchParams.get("home"), "/?q=git");
  assert.deepEqual(investigationPresets.parseInvestigationUrl(url.search).values, {
    base: base.hash, target: target.hash, mode: "direct",
  });
  change("reflogを調べるref", "refs/heads/main");
  assert.equal(link(), undefined);
});

test("tag comparison preserves explicit order across searches and uses only commit target hashes", async () => {
  const Compare = () => null;
  const old = { name: "v0.6.130", type: "annotated", hash: "a".repeat(40), peeled_hash: "b".repeat(40), peeled_type: "commit" };
  const next = { name: "v0.6.131", type: "lightweight", hash: "c".repeat(40), peeled_hash: "c".repeat(40), peeled_type: "commit" };
  const blob = { ...old, name: "blob", peeled_type: "blob" };
  const tagExplorer = componentHarness("tag-explorer.tsx", {
    "./commit-compare": { default: Compare },
    "./copy-button": { default: () => null },
    "./tag-explorer-tools.mjs": tagTools,
    "./tag-investigation-tools.mjs": tagInvestigation,
  }, async () => ({ ok: true, json: async () => ({ tags: [old, next, blob] }) }));
  const render = () => tagExplorer({ path: "/repos/thinkplatform-lib" });
  const refresh = () => findNode(render(), (node) => node.props.className === "tag-explorer-refresh").props.onClick();
  const select = (tag) => findNode(render(), (node) => node.props["aria-label"] === `${tag.name}の詳細を表示`).props.onClick();
  const compare = () => findNode(render(), (node) => node.type === Compare);
  const setBase = (tag) => findNode(render(), (node) => node.props["aria-label"] === `${tag.name} を比較元にする`);

  refresh();
  await setImmediate();
  select(old);
  setBase(old).props.onClick();
  assert.equal(compare(), undefined);
  select(blob);
  assert.equal(setBase(blob), undefined);
  assert.equal(compare(), undefined);

  findNode(render(), (node) => node.props.type === "search").props.onChange({ target: { value: next.name } });
  select(next);
  assert.deepEqual(compare().props.laneComparison, {
    base: old.peeled_hash, target: next.peeled_hash, baseLabel: `${old.name} → ${next.name}`,
    directLabel: "このタグまで比較", supportsMergeBase: false,
  });

  refresh();
  await setImmediate();
  select(next);
  assert.equal(compare(), undefined);
});

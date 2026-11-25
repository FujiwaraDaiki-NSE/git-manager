import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as branchRelation from "../app/branch-relation.mjs";
import * as tagTools from "../app/tag-explorer-tools.mjs";
import * as tagInvestigation from "../app/tag-investigation-tools.mjs";

function componentHarness(filename, dependencies, fetch) {
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
    useRef: (current) => ({ current }),
  };
  new Function("require", "exports", "fetch", compiled.outputText)((id) => {
    if (id === "react") return hooks;
    if (id.endsWith(".css")) return {};
    return dependencies[id] ?? require(id);
  }, exports, fetch);
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

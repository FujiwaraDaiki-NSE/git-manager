import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as repositoryFilesTools from "../app/repository-files-tools.mjs";

test("comparison sources load the two pinned file paths and show each response independently", async () => {
  const source = new URL("../app/commit-compare.tsx", import.meta.url);
  const require = createRequire(source);
  const { outputText } = ts.transpileModule(readFileSync(source, "utf8") + "\nexport { ComparisonFileSources };", {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  });
  const exports = {};
  const calls = [];
  const fetch = (url, { signal }) => new Promise((resolve) => calls.push({ url: new URL(url, "http://localhost"), signal, resolve }));
  let current;
  const hooks = {
    useState(initial) {
      const side = current;
      return [side.state ?? initial, (value) => { side.state = value; }];
    },
    useEffect(effect) { current.cleanup ??= effect(); },
  };
  new Function("require", "exports", "fetch", outputText)((id) => {
    if (id === "react") return hooks;
    if (id === "./repository-files-tools.mjs") return repositoryFilesTools;
    return id.startsWith("./") ? {} : require(id);
  }, exports, fetch);

  function openRow(file) {
    const view = exports.ComparisonFileSources({
      path: "/tmp/repo + name", comparison: { base: "input-base", comparison_base: "actual-base", target: "target" }, file,
    });
    return view.props.children.map((element) => {
      const side = {};
      return {
        render() { current = side; return renderToStaticMarkup(element.type(element.props)); },
        close() { side.cleanup(); },
      };
    });
  }

  async function respond(index, status, json) {
    calls[index].resolve(Response.json(json, { status }));
    await new Promise(setImmediate);
  }

  const [before, after] = openRow({ old_path: "old/文 +?#.txt", path: "new/文 +?#.txt" });
  assert.equal(calls.length, 0);
  assert.match(before.render(), /原文を取得中/);
  assert.match(after.render(), /原文を取得中/);
  assert.deepEqual(calls.map(({ url }) => [url.pathname, Object.fromEntries(url.searchParams)]), [
    ["/api/repo/file", { path: "/tmp/repo + name", revision: "actual-base", file: "old/文 +?#.txt" }],
    ["/api/repo/file", { path: "/tmp/repo + name", revision: "target", file: "new/文 +?#.txt" }],
  ]);
  await respond(1, 200, { path: "new/文 +?#.txt", pinned_hash: "target", binary: false, text: "<after>\n", truncated: true });
  assert.match(after.render(), /取得上限.*&lt;after&gt;\n<\/pre>/);
  assert.match(before.render(), /原文を取得中/);
  await respond(0, 200, { path: "old/文 +?#.txt", pinned_hash: "actual-base", binary: true, text: null, truncated: false });
  assert.match(before.render(), /バイナリ/);
  before.close();
  after.close();
  assert.ok(calls.every(({ signal }) => signal.aborted));

  const [addedBefore, addedAfter] = openRow({ path: "added.txt" });
  addedBefore.render();
  addedAfter.render();
  assert.deepEqual(calls.slice(2).map(({ url }) => url.searchParams.get("file")), ["added.txt", "added.txt"]);
  await respond(2, 404, { detail: "指定したrevisionにファイルがありません" });
  await respond(3, 200, { path: "added.txt", pinned_hash: "target", binary: false, text: "added\n", truncated: false });
  assert.match(addedBefore.render(), /この版にファイルはありません/);
  assert.match(addedAfter.render(), /added\n<\/pre>/);

  const [failedBefore, failedAfter] = openRow({ path: "failed.txt" });
  failedBefore.render();
  failedAfter.render();
  await respond(4, 404, { detail: "リポジトリが見つかりません" });
  await respond(5, 200, { path: "other.txt", pinned_hash: "target", binary: false, text: "other", truncated: false });
  assert.match(failedBefore.render(), /原文を取得できませんでした（HTTP 404）/);
  assert.match(failedAfter.render(), /原文の応答を確認できませんでした/);
});

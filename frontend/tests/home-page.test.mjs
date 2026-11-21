import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const source = new URL("../app/page.tsx", import.meta.url);
const require = createRequire(source);
const code = ts.transpileModule(readFileSync(source, "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function home() {
  let stream;
  let cursor;
  let effects;
  const states = [];
  const exports = {};
  const localStorage = { getItem: () => null, setItem() {} };
  runInNewContext(code, {
    exports, URLSearchParams, localStorage, document: {},
    window: { localStorage, location: { search: "" }, addEventListener() {}, removeEventListener() {} },
    require(name) {
      if (name === "./repo-stream") return { useRepoStream: () => stream, useProjectsLiveUpdates() {} };
      if (name === "react") return {
        useMemo: (calculate) => calculate(),
        useEffect: (effect) => effects.push(effect),
        useId: () => "agent-list",
        useRef: (current) => ({ current }),
        useState(initial) {
          const index = cursor++;
          if (!(index in states)) states[index] = initial;
          return [states[index], (next) => { states[index] = typeof next === "function" ? next(states[index]) : next; }];
        },
      };
      if (name.endsWith(".mjs") || name === "react/jsx-runtime") return require(name);
      if (name === "./git-state-facts") return { FetchFacts: () => null };
      return { default: () => null };
    },
  });
  return (snapshot) => {
    stream = { repos: new Map(), projectsCachedAt: null, fetching: null, ...snapshot };
    cursor = 0;
    effects = [];
    exports.default();
    effects.forEach((effect) => effect());
    cursor = 0;
    return renderToStaticMarkup(exports.default());
  };
}

const project = (id, failures) => ({
  id, name: id.slice(1), main_path: id, lane_count: 3, remote: null, remote_status: "unset",
  git: { conflict: 0, dirty: 1, ahead: 0, behind: 0, merged: 0 },
  git_status_available: true, git_status_failed: failures,
});

test("Git status failure details follow common_dir and remove recovered paths", () => {
  const render = home();
  const projects = [project("/alpha", 2), project("/beta", 1)];
  let repos = new Map([
    ["/alpha", { common_dir: "/alpha", path: "/alpha", error: "権限エラー" }],
    ["/worktrees/alpha", { common_dir: "/alpha", path: "/worktrees/alpha", error: "Gitエラー" }],
    ["/worktrees/beta", { common_dir: "/beta", path: "/worktrees/beta", error: "別プロジェクトのエラー" }],
  ]);
  const cards = () => [...render({ projectSummaries: projects, projectsLoading: false, projectsError: null, repos }).matchAll(/<article.*?<\/article>/g)].map(([card]) => card);
  const alphaCard = () => cards().find((card) => card.includes('aria-label="alpha"'));
  assert.match(alphaCard(), /<summary>.*取得失敗 2件.*<\/summary>.*ライブ明細 2件.*<code>\/alpha<\/code>.*権限エラー.*<code>\/worktrees\/alpha<\/code>.*Gitエラー/);
  assert.doesNotMatch(alphaCard(), /別プロジェクトのエラー/);
  repos = new Map(repos).set("/worktrees/alpha", { ...repos.get("/worktrees/alpha"), error: null });
  assert.match(alphaCard(), /取得失敗 2件.*ライブ明細 1件/);
  assert.doesNotMatch(alphaCard(), /\/worktrees\/alpha|Gitエラー/);
});

test("Home distinguishes failed initial, successful empty, and previous project counts", () => {
  const render = home();
  const empty = { projectSummaries: [], projectsLoading: false };
  const failed = { ...empty, projectsError: "HTTP 503" };

  const initialFailure = render(failed);
  assert.match(initialFailure, /class="project-total">取得失敗.*Git件数の取得失敗.*プロジェクト一覧の取得失敗/);
  assert.doesNotMatch(initialFailure, /0 ブランチ|0 作業ディレクトリ|登録されたプロジェクトはありません/);

  const successfulEmpty = render({ ...empty, projectsError: null });
  assert.match(successfulEmpty, /class="project-total">0<.*0 ブランチ.*0 作業ディレクトリ.*登録されたプロジェクトはありません/);
  assert.match(render(failed), /class="project-total">前回取得 · 0<.*前回取得 · 0 ブランチ/);

  const cached = home()({ ...failed, projectsCachedAt: Date.now(), projectSummaries: [project("/alpha", 0)] });
  assert.match(cached, /class="project-total">前回取得 · 1<.*前回取得 · 3 ブランチ.*1 作業ディレクトリ.*前回取得した一覧を表示しています/);
});

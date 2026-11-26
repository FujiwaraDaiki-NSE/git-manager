import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { parseProjectUrl } from "../app/project-flow.mjs";

const source = new URL("../app/page.tsx", import.meta.url);
const require = createRequire(source);
const code = ts.transpileModule(readFileSync(source, "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function home(search = "", onAgentCountButton) {
  let stream;
  let cursor;
  let effects;
  const states = [];
  const exports = {};
  const localStorage = { getItem: () => null, setItem() {} };
  runInNewContext(code, {
    exports, URLSearchParams, localStorage, document: {},
    window: { localStorage, location: { search }, addEventListener() {}, removeEventListener() {} },
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
      if (name === "react/jsx-runtime") {
        const runtime = require(name);
        return {
          ...runtime,
          jsxs(type, props, key) {
            if (type === "button" && props["aria-controls"] === "agent-list") onAgentCountButton?.(key, props.onClick);
            return runtime.jsxs(type, props, key);
          },
        };
      }
      if (name.endsWith(".mjs")) return require(name);
      if (name === "next/link") return { default: ({ prefetch, ...props }) => require("react").createElement("a", props) };
      if (name === "./agent-decision") return { AgentDecisionDetails: () => null };
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
  git: { conflict: 0, dirty: 1, ahead: 0, behind: 0, merged: 0, prunable: 0 },
  worktree_count: 0,
  git_status_available: true, git_status_failed: failures,
  next_lane: null, next_lane_id: null,
});

test("Git next-check links use lane IDs and omit selection when the ID is null", () => {
  const render = home("?q=alpha");
  for (const [label, id, display] of [
    ["main", "branch:main", "main"],
    ["(detached)", "worktree:/worktrees/alpha detached", "HEAD切り離し（ブランチなし）"],
    ["main", null, "main"],
  ]) {
    const html = render({
      projectSummaries: [{ ...project("/alpha", 0), next_lane: label, next_lane_id: id }],
      projectsLoading: false, projectsError: null,
    });
    const [, href, linkLabel] = html.match(/次に確認 <a href="([^"]+)"><strong>([^<]+)<\/strong>/);
    const url = new URL(href.replaceAll("&amp;", "&"), "http://localhost");
    assert.equal(linkLabel, display);
    assert.equal(url.pathname, "/project");
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      path: "/alpha", tab: "lanes", range: "current", ...(id === null ? {} : { lane: id }), home: "q=alpha",
    });
  }
});

test("Home filters for Git status failures independently of fetch failures", () => {
  const render = home("?git=git-status-failure");
  const html = render({
    projectSummaries: [
      project("/alpha", 2),
      { ...project("/beta", 1), git_status_available: false },
      { ...project("/gamma", 0), fetch_status: { result: "failure" } },
    ],
    projectsLoading: false, projectsError: null,
  });
  assert.match(html, /aria-pressed="true">Git状態の取得失敗<span class="filter-count">2<\/span>/);
  assert.match(html, /aria-pressed="false">fetch失敗<span class="filter-count">1<\/span>/);
  assert.match(html, /<article[^>]*aria-label="alpha"/);
  assert.match(html, /<article[^>]*aria-label="beta"/);
  assert.doesNotMatch(html, /<article[^>]*aria-label="gamma"/);
});

test("Home labels additional worktrees, including zero", () => {
  const html = home()({
    projectSummaries: [project("/alpha", 0), { ...project("/beta", 0), worktree_count: 35 }],
    projectsLoading: false, projectsError: null,
  });
  assert.match(html, /管理情報 <span>追加worktree 0件<\/span>/);
  assert.match(html, /管理情報 <span>追加worktree 35件<\/span>/);
});

test("Home expands all active reports and keeps their original status labels", () => {
  const clicks = new Map();
  const render = home("", (key, click) => clicks.set(key, click));
  const tasks = [
    ["waiting_for_user", "waiting"], ["blocked", "blocked"], ["review_required", "review"],
    ["investigating", "investigate"], ["implementing", "implement"], ["testing", "test"], ["reviewing", "reviewing"],
  ].map(([status, branch]) => ({ kind: "status", status, branch, project_id: "/alpha" }));
  const snapshot = {
    projectSummaries: [{
      ...project("/alpha", 0),
      agent_priority_counts: { waiting_for_user: 1, blocked: 1, review_required: 1, active: 4 },
      agent_tasks: tasks,
    }],
    projectsLoading: false, projectsError: null,
  };
  const collapsed = render(snapshot);
  assert.match(collapsed, /aria-expanded="false"><strong>4<\/strong> 実行中/);
  assert.match(collapsed, /上位ブランチの作業状況/);
  clicks.get("active")();
  const expanded = render(snapshot);
  assert.match(expanded, /aria-expanded="true"><strong>4<\/strong> 実行中/);
  const list = expanded.match(/aria-label="実行中のブランチ">(.*?)<div class="project-card-event">/)[1];
  assert.equal([...list.matchAll(/class="agent-task-entry"/g)].length, 4);
  assert.match(list, /調査中.*>investigate<.*実装中.*>implement<.*テスト中.*>test<.*レビュー中.*>reviewing</);
  assert.doesNotMatch(list, /入力待ち|問題あり|レビュー待ち/);
  clicks.get("active")();
  assert.match(render(snapshot), /上位ブランチの作業状況/);
});

test("Home filters prunable worktrees independently of Git status failures", () => {
  const alpha = project("/alpha", 0);
  const html = home("?git=prunable")({
    projectSummaries: [{ ...alpha, git: { ...alpha.git, prunable: 3 } }, project("/beta", 19)],
    projectsLoading: false, projectsError: null,
  });
  assert.match(html, /aria-pressed="true">参照先なしworktreeあり<span class="filter-count">1<\/span>/);
  assert.match(html, /<article[^>]*aria-label="alpha"/);
  assert.doesNotMatch(html, /<article[^>]*aria-label="beta"/);
});

test("Home counts dormant projects within the current search and Git filter", () => {
  const dormant = (id, behind) => {
    const item = project(id, 0);
    return {
      ...item,
      git: { ...item.git, dirty: 0, behind },
      latest_event: { date: "2020-01-01T00:00:00Z" },
      agent_tasks: null,
      agent_counts: { running: null, waiting_for_user: null, problem: null, reviewing: null, integratable: null },
      agent_priority_counts: { waiting_for_user: null, blocked: null, active: null, review_required: null, merge_ready: null, completed: null },
    };
  };
  const snapshot = {
    projectSummaries: [
      dormant("/alpha-dormant", 1),
      { ...project("/alpha-active", 0), git: { dirty: 1, conflict: 0, ahead: 0, behind: 1 } },
      dormant("/alpha-no-behind", 0),
      dormant("/beta-dormant", 1),
    ],
    projectsLoading: false, projectsError: null,
  };
  const shown = home("?q=alpha&git=behind")(snapshot);
  const hidden = home("?q=alpha&git=behind&hideDormant=1")(snapshot);
  assert.match(shown, /休眠プロジェクトを隠す<span class="filter-count">1件<\/span>/);
  assert.match(shown, /2 \/ 4 プロジェクトを表示中/);
  assert.match(hidden, /休眠プロジェクトを隠す<span class="filter-count">1件を非表示<\/span>/);
  assert.match(hidden, /1 \/ 4 プロジェクトを表示中/);
  assert.match(hidden, /<article[^>]*aria-label="alpha-active"/);
});

test("Home describes the largest default-branch difference among checked-out branches", () => {
  const html = home()({
    projectSummaries: [{ ...project("/design_db", 0), largest_difference_lane: "feature" }],
    projectsLoading: false, projectsError: null,
  });
  assert.match(html, /<dt>チェックアウト中で既定との差が最大（ahead \+ behind）<\/dt><dd>feature<\/dd>/);
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

test("Home lists observed operations per worktree and links to the current lane", () => {
  const render = home("?q=main");
  const snapshot = { projectSummaries: [], projectsLoading: false, projectsError: null };
  const repos = new Map([
    ["/projects/git-manager", { path: "/projects/git-manager", common_dir: "/projects/git-manager", branch: "main", operations: [{ kind: "cherry-pick" }, { kind: "merge" }] }],
    ["/worktrees/beta", { path: "/worktrees/beta", common_dir: "/projects/beta", branch: "main", operations: [{ kind: "merge" }] }],
    ["/worktrees/alpha detached", { path: "/worktrees/alpha detached", common_dir: "/projects/git-manager", branch: "(detached)", detached: true, operations: [{ kind: "rebase" }] }],
    ["/unknown", { path: "/unknown", common_dir: "/unknown", operations: null }],
    ["/pending", { path: "/pending", common_dir: "/pending" }],
  ]);
  const section = (rows) => render({ ...snapshot, repos: rows }).match(/<section aria-labelledby="home-git-operations-title">.*?<\/section>/)?.[0];
  const items = (rows) => [...section(rows).matchAll(/<li[^>]*><a [^>]*href="([^"]+)">([^<]+)<\/a><\/li>/g)].map(([, href, label]) => {
    const url = new URL(href.replaceAll("&amp;", "&"), "http://localhost");
    const { path, lane, tab, range, invalidParams } = parseProjectUrl(url.search);
    assert.equal(url.pathname, "/project");
    assert.equal(tab, "lanes");
    assert.equal(range, "current");
    assert.deepEqual(invalidParams, []);
    assert.equal(url.searchParams.get("home"), "q=main");
    return { label, path, lane };
  });
  assert.deepEqual(items(repos), [
    { label: "git-manager / main · cherry-pick、merge", path: "/projects/git-manager", lane: "branch:main" },
    { label: "beta / main · merge", path: "/worktrees/beta", lane: "branch:main" },
    { label: "git-manager / detached HEAD · rebase", path: "/worktrees/alpha detached", lane: "worktree:/worktrees/alpha detached" },
  ]);
  assert.doesNotMatch(section(repos), /home-git-operation-path/);
  snapshot.projectSummaries = [
    { ...project("/projects/git-manager", 0), name: "git-manager" },
    { ...project("/other/git-manager", 0), name: "git-manager" },
    { ...project("/projects/beta", 0), name: "beta" },
  ];
  const withDuplicates = section(repos);
  assert.match(withDuplicates, /git-manager \/ main · cherry-pick、merge<\/a> · <code class="home-git-operation-path">\/projects\/git-manager<\/code>/);
  assert.match(withDuplicates, /git-manager \/ detached HEAD · rebase<\/a> · <code class="home-git-operation-path">\/projects\/git-manager<\/code>/);
  assert.match(withDuplicates, /beta \/ main · merge<\/a><\/li>/);
  const updated = new Map(repos);
  for (const [path, repo] of repos) {
    if (repo.operations?.length) updated.set(path, { ...repo, operations: [] });
  }
  assert.equal(section(updated), undefined);
});

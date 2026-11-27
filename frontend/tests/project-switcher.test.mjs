import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import {parseRecentProjectPaths, recordRecentProjectPath, serializeRecentProjectPaths, filterProjectSwitcherProjects, findProjectSwitcherWorktrees, sortProjectSwitcherProjects, projectSwitcherResultIndex} from '../app/project-switcher-tools.mjs';

const require = createRequire(new URL('../app/project-switcher.tsx', import.meta.url));
const compilerOptions = { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 };

test('a linked worktree visit passes the main path returned by the project API to the switcher', () => {
  const source = readFileSync(new URL('../app/project-control.tsx', import.meta.url), 'utf8');
  const switcher = source.match(/<ProjectSwitcher\s[^>]*\/>/)[0];
  const { outputText } = ts.transpileModule(switcher, { compilerOptions });
  const { props } = runInNewContext(outputText, {
    exports: {},
    require,
    ProjectSwitcher: () => null,
    project: { main_path: '/main' },
    urlState: { path: '/linked' },
    homeQuery: null,
  });
  assert.equal(props.currentPath, '/main');
});

test('a failed project refresh keeps matches and retry visible when projects are already available', () => {
  const source = readFileSync(new URL('../app/project-switcher.tsx', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions });
  const render = (projects) => {
    const exports = {};
    runInNewContext(outputText, {
      exports,
      require(name) {
        if (name.endsWith('.css')) return {};
        if (name === './repo-stream') return { useRepoStream: () => ({
          repos: new Map(), projectSummaries: projects, projectsLoading: false, projectsError: 'offline',
          refreshProjects() {}, subscribeProjectsLiveUpdates() {},
        }) };
        if (name === 'next/link') return { default: ({ prefetch, ...props }) => require('react').createElement('a', props) };
        return require(name);
      },
    });
    return renderToStaticMarkup(require('react').createElement(exports.default, { currentPath: null, homeQuery: null }));
  };

  const retained = render([{ id: 'alpha', name: 'Alpha', main_path: '/alpha' }]);
  assert.match(retained, /role="alert".*前回取得した一覧を表示しています。.*再試行/);
  assert.match(retained, /role="status">1 プロジェクト/);
  assert.match(retained, /data-project-switch-result="true".*<strong>Alpha<\/strong>/);

  const initialFailure = render([]);
  assert.match(initialFailure, /role="alert".*再試行/);
  assert.doesNotMatch(initialFailure, /前回取得した一覧|data-project-switch-result|検索をクリア/);
});

test('recent paths distinguish absent from corrupt storage and keep exact unique visit order',()=>{
 assert.deepEqual(parseRecentProjectPaths(null),[]);
 assert.equal(parseRecentProjectPaths('{broken'),null);
 assert.equal(parseRecentProjectPaths('[1]'),null);
 assert.deepEqual(parseRecentProjectPaths('["/a","/b","/a"]'),['/a','/b']);
 const before=['/a','/b'];assert.deepEqual(recordRecentProjectPath(before,'/b'),['/b','/a']);
 assert.deepEqual(before,['/a','/b']);assert.deepEqual(recordRecentProjectPath(before,null),before);
});
test('favorite and recent intersection uses exact identities, not duplicate names',()=>{
 const rows=[{id:'a',name:'same',main_path:'/a',remote:null},{id:'b',name:'same',main_path:'/b',remote:null}];
 assert.deepEqual(filterProjectSwitcherProjects(rows,{query:'same',favoritesOnly:true,recentOnly:true,favoriteIds:new Set(['a']),recentPaths:['/b']}),[]);
 assert.deepEqual(filterProjectSwitcherProjects(rows,{query:'/a',favoritesOnly:true,recentOnly:true,favoriteIds:new Set(['a']),recentPaths:['/a']}),[rows[0]]);
 assert.deepEqual(sortProjectSwitcherProjects(rows,'name',[]),rows);
 assert.throws(()=>sortProjectSwitcherProjects(rows,'invalid',[]));
});

test('last opened follows saved main paths, with unvisited projects afterward by name', () => {
  const gitManager = { id: 'git-manager', name: 'git-manager', main_path: '/git-manager' };
  const designDb = { id: 'design-db', name: 'design_db', main_path: '/design_db' };
  const unvisited = { id: 'other', name: 'design_db', main_path: '/other/design_db' };
  const missingPath = { id: 'unknown', name: 'alpha', main_path: null };
  const projects = [designDb, unvisited, gitManager, missingPath];
  const history = ['/git-manager', '/design_db', '/git-manager'].reduce(recordRecentProjectPath, []);
  const reloaded = parseRecentProjectPaths(serializeRecentProjectPaths(history));
  assert.deepEqual(sortProjectSwitcherProjects(projects, 'last-opened', reloaded), [
    gitManager, designDb, missingPath, unvisited,
  ]);
  assert.deepEqual(projects, [designDb, unvisited, gitManager, missingPath]);
});
test('keyboard arrows wrap, Home/End select boundaries, invalid indexes do not move focus',()=>{
 assert.equal(projectSwitcherResultIndex('ArrowUp',0,3),2);
 assert.equal(projectSwitcherResultIndex('ArrowDown',2,3),0);
 assert.equal(projectSwitcherResultIndex('Home',2,3),0);
 assert.equal(projectSwitcherResultIndex('End',0,3),2);
 assert.equal(projectSwitcherResultIndex('ArrowDown',0,0),null);
 assert.equal(projectSwitcherResultIndex('Enter',0,3),null);
});

test("worktree search keeps same-name branches in their own projects and links to the selected lane", () => {
  const projects = [
    { id: "/a", name: "Alpha", main_path: "/a" },
    { id: "/b-admin", name: "Beta", main_path: "/b" },
  ];
  const repos = new Map([
    ["/b", { path: "/b", common_dir: "/b-admin", branch: "feature/shared" }],
    ["/a-task", { path: "/a-task", common_dir: "/a", branch: "feature/shared" }],
    ["/a-detached #1", { path: "/a-detached #1", common_dir: "/a", branch: "(detached)", detached: true }],
    ["/a-removed", { path: "/a-removed", common_dir: "/a", branch: "feature/shared", worktree_state: "prunable" }],
  ]);
  const filters = { query: " FEATURE/SHARED ", favoritesOnly: false, recentOnly: false, favoriteIds: new Set(["/a"]), recentPaths: ["/b"] };
  const search = (options) => findProjectSwitcherWorktrees(projects, repos, { ...filters, ...options }, "git=dirty");
  const matches = search({});
  assert.deepEqual(matches.map(({ project, path }) => [project.name, path]), [["Alpha", "/a-task"], ["Beta", "/b"]]);
  assert.deepEqual(matches.map(({ href }) => Object.fromEntries(new URL(href, "http://localhost").searchParams)), [
    { path: "/a", tab: "flow", range: "7d", lane: "branch:feature/shared", home: "git=dirty" },
    { path: "/b", tab: "flow", range: "7d", lane: "branch:feature/shared", home: "git=dirty" },
  ]);
  assert.deepEqual(search({ favoritesOnly: true }).map(({ path }) => path), ["/a-task"]);
  assert.deepEqual(search({ recentOnly: true }).map(({ path }) => path), ["/b"]);
  assert.deepEqual(search({ query: "alpha   FEATURE/SHARED /a-task" }), [matches[0]]);
  assert.deepEqual(search({ query: "/a-task\tfeature/shared Alpha" }), [matches[0]]);
  assert.deepEqual(search({ query: "beta feature/shared /a-task" }), []);
  assert.deepEqual(search({ query: " " }), []);
  const [detached] = search({ query: "detached #1" });
  assert.equal(detached.branch, null);
  assert.equal(new URL(detached.href, "http://localhost").searchParams.get("lane"), "worktree:/a-detached #1");
});

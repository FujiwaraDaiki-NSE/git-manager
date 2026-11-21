import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRecentProjectPaths, recordRecentProjectPath, filterProjectSwitcherProjects, findProjectSwitcherWorktrees, sortProjectSwitcherProjects, projectSwitcherResultIndex} from '../app/project-switcher-tools.mjs';

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
 assert.deepEqual(sortProjectSwitcherProjects(rows,'name'),rows);
 assert.throws(()=>sortProjectSwitcherProjects(rows,'invalid'));
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
  assert.deepEqual(search({ query: " " }), []);
  const [detached] = search({ query: "detached #1" });
  assert.equal(detached.branch, null);
  assert.equal(new URL(detached.href, "http://localhost").searchParams.get("lane"), "worktree:/a-detached #1");
});

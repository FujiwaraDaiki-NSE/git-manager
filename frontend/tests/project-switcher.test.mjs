import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRecentProjectPaths, recordRecentProjectPath, filterProjectSwitcherProjects, sortProjectSwitcherProjects, projectSwitcherResultIndex} from '../app/project-switcher-tools.mjs';

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

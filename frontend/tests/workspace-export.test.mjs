import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceCsv, workspaceMarkdown, workspaceSnapshot} from '../app/workspace-snapshot.mjs';

const project = {name:' =SUM(1,2)', main_path:'/test/"a\nb"', remote:null, lane_count:null, worktree_count:0, git:{dirty:2,conflict:null,ahead:0,behind:1},git_status_available:true,git_status_failed:0,agent_state:null};
const view = {query:'test', gitFilter:'dirty'};
const time = '2026-10-09T03:50:00Z';
test('CSV keeps exact selected rows, explicit unknowns, view and timestamp, and neutralizes formulas',()=>{
  const csv = workspaceCsv([project],view,time);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"\' =SUM(1,2)"'));
  assert.ok(csv.includes('"/test/""a\nb"""'));
  assert.ok(csv.includes('"unknown","unknown","0","2","unknown","0","1","0","unknown"'));
  assert.ok(csv.includes('"{""query"":""test"",""gitFilter"":""dirty""}"'));
  assert.ok(csv.endsWith(`"${time}"\r\n`));
  assert.equal(workspaceCsv([],view,time).split('\r\n').length,2);
});

test('workspace exports distinguish clean, unavailable, and partially available Git counts', () => {
  const git = { dirty: 0, conflict: 0, ahead: 0, behind: 0, locked: 1 };
  const base = { ...project, main_path: '/test/repo', lane_count: 1, worktree_count: 2, git };
  const projects = [
    { ...base, name: 'clean' },
    { ...base, name: 'unavailable', git_status_available: false, git_status_failed: 3 },
    { ...base, name: 'partial', git_status_failed: 1, git: { ...git, dirty: 2, ahead: 1 } },
  ];
  const snapshot = JSON.parse(workspaceSnapshot(projects, view, time));
  assert.deepEqual(snapshot.projects.map(({ git, gitStatusAvailable, gitStatusFailed }) => [git, gitStatusAvailable, gitStatusFailed]), [
    [git, true, 0],
    [{ dirty: null, conflict: null, ahead: null, behind: null, locked: 1 }, false, 3],
    [{ ...git, dirty: 2, ahead: 1 }, true, 1],
  ]);

  const [header, ...rows] = workspaceCsv(projects, view, time).split('\r\n');
  assert.deepEqual(header.split(',').slice(5, 10), ['"dirty"', '"conflict"', '"ahead"', '"behind"', '"git_status_failed"']);
  assert.deepEqual(rows.slice(0, 3).map(row => row.split(',').slice(5, 10)), [
    ['"0"', '"0"', '"0"', '"0"', '"0"'],
    ['""', '""', '""', '""', '"3"'],
    ['"2"', '"0"', '"1"', '"0"', '"1"'],
  ]);

  const markdown = workspaceMarkdown(projects, view, time);
  assert.match(markdown, /\| Git状態の取得失敗 \|/);
  assert.match(markdown, /\| clean \| \/test\/repo \| 未取得 \| 1 \| 2 \| 0 \| 0 \| 0 \| 0 \| 0 \|/);
  assert.match(markdown, /\| unavailable \| \/test\/repo \| 未取得 \| 1 \| 2 \| 未取得 \| 未取得 \| 未取得 \| 未取得 \| 3 \|/);
  assert.match(markdown, /\| partial \| \/test\/repo \| 未取得 \| 1 \| 2 \| 2 \| 0 \| 1 \| 0 \| 1 \|/);
});
test('Markdown escapes user strings and distinguishes missing counts from zero',()=>{
  const markdown = workspaceMarkdown([{...project,name:'[link](https://x)|<script>\n`code`',git:{dirty:NaN,conflict:-1,ahead:0,behind:null}}],view,time);
  assert.ok(markdown.includes('\\[link\\]\\(https://x\\)\\|&lt;script&gt;<br>\\`code\\`'));
  assert.ok(markdown.includes('| 未取得 | 未取得 | 0 | 未取得 |'));
  assert.ok(markdown.includes('表示件数: 1'));
  assert.ok(markdown.includes(time));
  assert.ok(markdown.includes('未取得は0件を意味しません'));
  assert.equal(project.git.dirty,2);
});

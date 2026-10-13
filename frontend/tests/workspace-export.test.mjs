import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceCsv, workspaceMarkdown} from '../app/workspace-snapshot.mjs';

const project = {name:' =SUM(1,2)', main_path:'/test/"a\nb"', remote:null, lane_count:null, worktree_count:0, git:{dirty:2,conflict:null,ahead:0,behind:1},agent_state:null};
const view = {query:'test', gitFilter:'dirty'};
const time = '2026-10-09T03:50:00Z';
test('CSV keeps exact selected rows, explicit unknowns, view and timestamp, and neutralizes formulas',()=>{
  const csv = workspaceCsv([project],view,time);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"\' =SUM(1,2)"'));
  assert.ok(csv.includes('"/test/""a\nb"""'));
  assert.ok(csv.includes('"unknown","unknown","0","2","unknown","0","1","unknown"'));
  assert.ok(csv.includes('"{""query"":""test"",""gitFilter"":""dirty""}"'));
  assert.ok(csv.endsWith(`"${time}"\r\n`));
  assert.equal(workspaceCsv([],view,time).split('\r\n').length,2);
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

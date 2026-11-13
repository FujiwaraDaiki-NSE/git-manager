import test from 'node:test';
import assert from 'node:assert/strict';
import { timelineRowGeometry, agentFreshness, rowAgentReports } from '../app/branch-timeline-presentation.mjs';

test('empty known history compresses without removing rows or shifting endpoints independently', () => {
  const rows = [{id:'a', history_available:true}, {id:'b', history_available:true}, {id:'c', history_available:false}];
  const geometry = timelineRowGeometry(rows, new Map([['b', [{}]]]));
  assert.deepEqual(geometry.rows.map(({top, center, height}) => [top, center, height]), [[0,22,44],[44,88,88],[132,176,88]]);
  assert.equal(geometry.height, 220);
});
test('freshness has explicit unknown and boundary states', () => {
  const time = '2026-01-01T00:00:00Z'; const now = Date.parse(time);
  assert.equal(agentFreshness(time, now), 'fresh');
  assert.equal(agentFreshness(time, now+3600000), 'recent');
  assert.equal(agentFreshness(time, now+86400000), 'old');
  assert.equal(agentFreshness(null, now), 'unknown');
  assert.equal(agentFreshness('invalid', now), 'unknown');
});
test('only explicit reports for exact row or local branches appear', () => {
  const row = {name:'main', locals:[{branch:'feature'}]};
  const tasks = [{branch:'feature',kind:'status',status:'testing'}, {branch:'main',kind:'lifecycle',status:'completed'}, {branch:'other',kind:'status',status:'implementing'}];
  assert.deepEqual(rowAgentReports(row,tasks), [tasks[0]]);
  assert.deepEqual(rowAgentReports(row,null), []);
});

import { isUnpushedCommit } from '../app/branch-timeline-presentation.mjs';
test('unpush marking includes older commits and requires known reachability for the exact upstream', () => {
  const lane = {head:'abc',upstream:'origin/main',unpushed_commits:['abc','parent']};
  const row = {tracking_ref:'origin/main',locals:[lane]};
  assert.equal(isUnpushedCommit(row,'abc'),true);
  assert.equal(isUnpushedCommit(row,'parent'),true);
  assert.equal(isUnpushedCommit({...row,locals:[{...lane,unpushed_commits:null}]},'abc'),false);
  assert.equal(isUnpushedCommit({...row,locals:[{...lane,unpushed_commits:[]}]},'abc'),false);
  assert.equal(isUnpushedCommit(row,'pushed'),false);
  assert.equal(isUnpushedCommit({...row,tracking_ref:'other'},'abc'),false);
});

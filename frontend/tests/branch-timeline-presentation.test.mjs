import test from 'node:test';
import assert from 'node:assert/strict';
import { timelineRowGeometry, agentFreshness, rowAgentReports, branchJumpLabel } from '../app/branch-timeline-presentation.mjs';

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
test('only explicit reports for branches present in the row locals appear', () => {
  const localRow = { name: 'topic', locals: [{ branch: 'topic' }, { branch: 'local-alias' }, { branch: null }] };
  const remoteRow = { name: 'topic', remote_ref: 'upstream/topic', locals: [] };
  const historicalRow = { name: 'topic', historical: true, locals: [] };
  const tasks = [
    { branch: 'topic', kind: 'status', status: 'waiting_for_user' },
    { branch: 'local-alias', kind: 'status', status: 'testing' },
    { branch: 'topic', kind: 'lifecycle', status: 'completed' },
    { branch: 'other', kind: 'status', status: 'implementing' },
    { branch: null, kind: 'status', status: 'testing' },
  ];
  assert.deepEqual(rowAgentReports(localRow, tasks), tasks.slice(0, 2));
  assert.deepEqual(rowAgentReports(remoteRow, tasks), []);
  assert.deepEqual(rowAgentReports(historicalRow, tasks), []);
  assert.deepEqual(rowAgentReports(localRow, null), []);
});

test('branch jump distinguishes duplicate names with the row status and preserves existing PR labels', () => {
  const local = { historical: false, status: 'local_only', pull_requests: [] };
  const remote = { historical: false, status: 'remote_only', remote_ref: 'origin/topic', pull_requests: [] };
  const history = { historical: true, status: 'historical_deleted', pull_requests: [{ number: 42, source_repository: 'owner/repo' }] };
  assert.equal(branchJumpLabel(local, 'topic', true), 'topic · ローカルのみ');
  assert.equal(branchJumpLabel(remote, 'topic', true), 'topic · origin/topic');
  assert.equal(branchJumpLabel({ ...remote, remote_ref: 'upstream/topic' }, 'topic', true), 'topic · upstream/topic');
  assert.equal(branchJumpLabel(history, 'topic', true), 'topic · PR #42 · 作成元 owner/repo');
  assert.equal(branchJumpLabel(local, 'topic', false), 'topic');
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { nextAgentCheck, workspaceAttention } from '../app/home-next-check.mjs';
import { updateAcknowledgements } from '../app/agent-acknowledgements.mjs';

const task = (branch, status, sequence) => ({ project_id: 'p', branch, kind: 'status', status, sequence, event_id: `e${sequence}`, occurred_at: `2026-11-17T00:00:0${sequence}Z` });
test('next check selects latest explicit waiting/blocked report and excludes exact acknowledged events', () => {
  const waiting = task('clean', 'waiting_for_user', 1);
  const blocked = task('blocked', 'blocked', 2);
  const project = { agent_tasks: [waiting, blocked, task('active', 'implementing', 3), { ...task('lifecycle', 'blocked', 4), kind: 'lifecycle' }], next_lane: 'dirty' };
  assert.equal(nextAgentCheck(project, {}).branch, 'blocked');
  const acknowledgements = updateAcknowledgements([blocked], {}, true);
  assert.equal(nextAgentCheck(project, acknowledgements).branch, 'clean');
  assert.equal(nextAgentCheck(project, updateAcknowledgements([waiting], acknowledgements, true)), null);
  assert.equal(nextAgentCheck({ agent_tasks: null }, {}), null);
  assert.equal(nextAgentCheck(project, null), null);
  assert.equal(nextAgentCheck({ agent_tasks: [task('blocked', 'blocked', 5)] }, acknowledgements).sequence, 5);
});
test('workspace distinguishes initial loading, no reports, refresh and actual failures', () => {
  assert.match(workspaceAttention([], true, null), /取得中/);
  assert.doesNotMatch(workspaceAttention([], true, null), /0件/);
  const projects = [{ agent_tasks: null }, { agent_tasks: [task('waiting', 'waiting_for_user', 1), task('blocked', 'blocked', 2)] }];
  assert.match(workspaceAttention(projects, false, null), /入力待ち 1件 · 問題あり 1件$/);
  assert.match(workspaceAttention([{ agent_tasks: null }], false, null), /入力待ち 0件 · 問題あり 0件$/);
  assert.match(workspaceAttention(projects, true, null), /取得中/);
  assert.match(workspaceAttention(projects, false, 'failed'), /一部未取得/);
  assert.match(workspaceAttention([], false, 'failed'), /取得失敗/);
});

test('next check prioritizes waiting/blocked, review, merge and excludes acknowledged reports', () => {
  const waiting = task('waiting', 'waiting_for_user', 1);
  const blocked = task('blocked', 'blocked', 2);
  const review = task('review', 'review_required', 3);
  const newerReview = task('newer-review', 'review_required', 4);
  const merge = task('merge', 'merge_ready', 5);
  const newerMerge = task('newer-merge', 'merge_ready', 6);
  const project = { agent_tasks: [merge, review, waiting, newerMerge, newerReview, blocked] };
  let acknowledgements = {};
  for (const expected of [blocked, waiting, newerReview, review, newerMerge, merge]) {
    assert.equal(nextAgentCheck(project, acknowledgements), expected);
    acknowledgements = updateAcknowledgements([expected], acknowledgements, true);
  }
  assert.equal(nextAgentCheck(project, acknowledgements), null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAttentionTracker, homeDocumentTitle, snapshotAge } from '../app/agent-attention.mjs';

const event = (sequence, status, branch = 'main') => ({ project_id: 'p', branch, kind: 'status', event_id: `e${sequence}`, sequence, occurred_at: '2026-11-14T00:00:00Z', status });
test('attention tracks branch transitions, rejects repeats, stale reports and lifecycle', () => {
  const observe = createAttentionTracker();
  observe(event(1, 'waiting_for_user')); // Initial snapshot is seeded without sending.
  assert.equal(observe(event(2, 'waiting_for_user')), false);
  assert.equal(observe(event(3, 'blocked')), true);
  assert.equal(observe(event(3, 'blocked')), false);
  assert.equal(observe(event(2, 'waiting_for_user')), false);
  assert.equal(observe({ ...event(4, 'completed'), kind: 'lifecycle' }), false);
  assert.equal(observe(event(5, 'implementing')), false);
  assert.equal(observe(event(6, 'waiting_for_user')), true);
  assert.equal(observe(event(7, 'blocked', 'other')), true);
});
test('home title and Git snapshot age use readable values', () => {
  assert.equal(homeDocumentTitle(7), '(7) 入力待ち · gitdash');
  assert.equal(homeDocumentTitle(0), 'gitdash');
  assert.equal(homeDocumentTitle(null), 'gitdash');
  const now = 1_000_000_000;
  for (const [seconds, label] of [[0, '1分未満前'], [120, '2分前'], [59462, '16時間前'], [172800, '2日前']]) {
    assert.equal(snapshotAge(now / 1000 - seconds, now), label);
  }
});

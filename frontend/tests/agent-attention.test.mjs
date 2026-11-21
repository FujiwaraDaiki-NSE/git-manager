import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
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

test('new waiting questions notify once; unchanged content and removed decisions do not', () => {
  const observe = createAttentionTracker();
  const waiting = (sequence, question) => ({ ...event(sequence, 'waiting_for_user'), decision: question === null ? null : { question, options: [], links: [] } });
  const first = waiting(1, '質問A');
  observe(first); // Initial/replayed snapshots are seeded without dispatching notifications.
  assert.equal(observe(waiting(2, '質問A')), false);
  const changed = waiting(3, '質問B');
  assert.equal(observe(changed), true);
  assert.equal(observe(changed), false);
  assert.equal(observe({ ...changed, decision: { ...changed.decision, question: '再送による変更' } }), false);
  assert.equal(observe(waiting(2, '遅れた質問')), false);
  assert.equal(observe(waiting(4, null)), false);
  assert.equal(observe(waiting(5, '質問C')), true);
});

test('notification body leads with the changed question and keeps existing dispatch rules', () => {
  const source = new URL('../app/desktop-notifications.tsx', import.meta.url);
  const require = createRequire(source);
  const code = ts.transpileModule(readFileSync(source, 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const observe = createAttentionTracker();
  const notifications = [];
  let listener;
  const exports = {};
  runInNewContext(code, {
    exports,
    window: { Notification: true, isSecureContext: true },
    localStorage: { getItem: () => 'true' },
    Notification: class {
      static permission = 'granted';
      constructor(_title, options) { notifications.push(options.body); }
    },
    require(name) {
      if (name === 'react') return {
        useState: value => [value, () => {}],
        useRef: current => ({ current }),
        useEffect: effect => effect(),
      };
      if (name === 'next/navigation') return { useRouter: () => ({}) };
      if (name === './repo-stream') return { useRepoStream: () => ({
        projectSummaries: [{ id: 'p', name: 'Project', main_path: '/project' }],
        subscribeAgentAttention: callback => { listener = callback; },
      }) };
      return require(name);
    },
  });
  exports.default();
  const waiting = (sequence, question) => ({
    ...event(sequence, 'waiting_for_user'), summary: '同じ要約', decision: { question, options: [], links: [] },
  });
  observe(waiting(1, '質問A'));
  const changed = waiting(2, '質問B');
  const blocked = { ...event(3, 'blocked'), summary: '問題の要約', decision: null };
  for (const report of [changed, changed, blocked]) {
    if (observe(report)) listener(report);
  }
  assert.deepEqual(notifications, ['質問B\nmain\n同じ要約', 'main\n問題の要約']);
});

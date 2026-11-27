import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createAttentionTracker, homeDocumentTitle, snapshotAge } from '../app/agent-attention.mjs';
import { FAVORITES_STORAGE_KEY } from '../app/home-overview.mjs';

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

function mountNotifications(storage) {
  const source = new URL('../app/desktop-notifications.tsx', import.meta.url);
  const require = createRequire(source);
  const code = ts.transpileModule(readFileSync(source, 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const notifications = [];
  const stateUpdates = [];
  const storageListeners = new Map();
  let listener;
  const exports = {};
  runInNewContext(code, {
    exports,
    window: {
      Notification: true, isSecureContext: true,
      addEventListener: (type, callback) => storageListeners.set(type, callback),
    },
    localStorage: storage,
    Notification: class {
      static permission = 'granted';
      constructor(_title, options) { notifications.push(options.body); }
    },
    require(name) {
      if (name === 'react') return {
        useState: value => [value, next => stateUpdates.push(next)],
        useRef: current => ({ current }),
        useEffect: effect => effect(),
      };
      if (name === 'next/navigation') return { useRouter: () => ({}) };
      if (name === './repo-stream') return { useRepoStream: () => ({
        projectSummaries: [
          { id: 'p', name: 'Project', main_path: '/project' },
          { id: 'q', name: 'Other project', main_path: '/other' },
        ],
        subscribeAgentAttention: callback => { listener = callback; },
      }) };
      return require(name);
    },
  });
  const view = exports.default();
  return {
    listener, notifications, stateUpdates,
    onStorage: storageListeners.get('storage'),
    selectScope: (value) => view.props.children[1].props.children[1].props.onChange({ currentTarget: { value } }),
  };
}

const enabledNotificationSettings = () => new Map([['gitdash.desktop-notifications', 'true']]);
const scopeKey = 'gitdash.desktop-notification-scope';

test('notification body leads with the changed question and keeps existing dispatch rules', () => {
  const observe = createAttentionTracker();
  const settings = enabledNotificationSettings();
  const { listener, notifications } = mountNotifications({ getItem: key => settings.get(key) ?? null });
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

test('favorites scope persists and matches the latest stored project IDs at dispatch', () => {
  const settings = enabledNotificationSettings();
  settings.set(FAVORITES_STORAGE_KEY, '["p"]');
  const storage = { getItem: key => settings.get(key) ?? null, setItem: (key, value) => settings.set(key, value) };
  const first = mountNotifications(storage);
  first.selectScope('favorites');
  assert.equal(settings.get(scopeKey), 'favorites');
  const { listener, notifications } = mountNotifications(storage);
  const report = { ...event(5, 'blocked'), summary: '問題の要約' };
  listener({ ...report, project_id: 'q' });
  listener(report);
  settings.set(FAVORITES_STORAGE_KEY, '["q"]');
  listener(report);
  listener({ ...report, project_id: 'q', summary: '別の要約' });
  settings.delete(FAVORITES_STORAGE_KEY);
  listener({ ...report, project_id: 'q' });
  assert.deepEqual(notifications, ['main\n問題の要約', 'main\n別の要約']);
});

test('cross-tab scope changes update the selection and the notification filter', () => {
  const settings = enabledNotificationSettings();
  settings.set(FAVORITES_STORAGE_KEY, '["p"]');
  const storage = { getItem: key => settings.get(key) ?? null, setItem: (key, value) => settings.set(key, value) };
  const first = mountNotifications(storage);
  const second = mountNotifications(storage);
  first.selectScope('favorites');
  second.onStorage({ storageArea: storage, key: scopeKey, newValue: settings.get(scopeKey) });
  assert.equal(second.stateUpdates.at(-2), 'favorites');
  second.listener({ ...event(5, 'blocked'), project_id: 'q' });
  second.listener(event(6, 'blocked'));
  assert.deepEqual(second.notifications, ['main']);
});

test('invalid scope and unreadable favorites suppress desktop delivery and expose a status', () => {
  const settings = enabledNotificationSettings();
  settings.set(scopeKey, 'invalid');
  const storage = { getItem: key => settings.get(key) ?? null };
  const invalid = mountNotifications(storage);
  invalid.listener(event(5, 'blocked'));
  assert.deepEqual(invalid.notifications, []);
  assert.ok(invalid.stateUpdates.includes('通知対象の設定を読み込めませんでした。'));

  settings.set(scopeKey, 'favorites');
  settings.set(FAVORITES_STORAGE_KEY, '{');
  const unreadable = mountNotifications(storage);
  unreadable.listener(event(5, 'blocked'));
  assert.deepEqual(unreadable.notifications, []);
  assert.equal(unreadable.stateUpdates.at(-1), true);
});

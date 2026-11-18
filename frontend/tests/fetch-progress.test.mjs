import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchProgressLabel } from '../app/fetch-progress.mjs';

test('fetch progress uses repository counts and omits zero failures', () => {
  assert.equal(fetchProgressLabel(null), null);
  assert.equal(fetchProgressLabel({ active: false, total: 60, done: 60, failed: 2 }), null);
  assert.equal(fetchProgressLabel({ active: true, total: 60, done: 0, failed: 0 }), 'fetch中 0/60リポジトリ完了');
  assert.equal(fetchProgressLabel({ active: true, total: 60, done: 12, failed: 2 }), 'fetch中 12/60リポジトリ完了・失敗2リポジトリ');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileStatusDescription, fileStatusGroups } from '../app/file-status.mjs';

test('staged and unstaged changes remain independently discoverable', () => {
  assert.equal(fileStatusGroups('M.').staged, true);
  assert.equal(fileStatusGroups('M.').unstaged, false);
  assert.equal(fileStatusGroups('.M').staged, false);
  assert.equal(fileStatusGroups('.M').unstaged, true);
  assert.equal(fileStatusGroups('MM').staged, true);
  assert.equal(fileStatusGroups('MM').unstaged, true);
  assert.equal(fileStatusDescription('MM'), 'ステージ: 変更 / 作業: 変更');
  assert.equal(fileStatusDescription('R.'), 'ステージ: 名前変更');
});

test('untracked files and conflicts do not masquerade as staged changes', () => {
  assert.equal(fileStatusGroups('??').untracked, true);
  assert.equal(fileStatusGroups('??').staged, false);
  for (const code of ['DD','AU','UD','UA','DU','AA','UU']) {
    assert.equal(fileStatusGroups(code).conflict,true);
    assert.equal(fileStatusGroups(code).staged,false);
    assert.equal(fileStatusGroups(code).unstaged,false);
    assert.equal(fileStatusDescription(code),'競合を解消してください');
  }
});

test('unrecognized status codes retain their raw label', () => {
  assert.equal(fileStatusDescription('XY'),'状態: XY');
  assert.deepEqual(fileStatusGroups('XY'),{all:true,staged:false,unstaged:false,untracked:false,conflict:false});
});

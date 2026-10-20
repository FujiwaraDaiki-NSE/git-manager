import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContentSearchFileHistoryHref,
  contentSearchContext,
  contentSearchCsv,
  contentSearchFileQuery,
  contentSearchQuery,
  contentSearchRequestKey,
} from '../app/content-search-tools.mjs';

const HASH = '0123456789abcdef0123456789abcdef01234567';

test('content search query carries explicit empty directory and case option', () => {
  const params = new URLSearchParams(contentSearchQuery('/repo', 'main', 'Needle', false, ''));
  assert.deepEqual(Object.fromEntries(params), {
    path: '/repo',
    revision: 'main',
    query: 'Needle',
    caseSensitive: 'false',
    directory: '',
  });
  assert.equal(contentSearchRequestKey('/repo', 'main', 'Needle', false, ''), JSON.stringify(['/repo', 'main', 'Needle', false, '']));
  assert.equal(contentSearchRequestKey('/repo', 'main', 'Needle', false, undefined), null);
  assert.throws(() => contentSearchQuery('/repo', 'main', 'Needle', undefined, ''), TypeError);
  assert.throws(() => contentSearchFileQuery('/repo', HASH, undefined), TypeError);
});

test('content context returns line numbers and highlights only the selected line', () => {
  assert.deepEqual(contentSearchContext('one\ntwo\nthree\nfour\nfive', 3, 1), {
    start: 2,
    end: 4,
    lines: [
      { line: 2, text: 'two', highlight: false },
      { line: 3, text: 'three', highlight: true },
      { line: 4, text: 'four', highlight: false },
    ],
  });
  assert.throws(() => contentSearchContext('one', 1, undefined), TypeError);
});

test('content CSV escapes formula-like matching text and preserves newlines', () => {
  const csv = contentSearchCsv([
    { path: '=path', line: 2, text: '+formula\nnext' },
    { path: 'safe.txt', line: 4, text: 'plain' },
  ]);
  assert.match(csv, /^\uFEFF"path","line","text"\r\n/);
  assert.match(csv, /"'=path","2","'\+formula\nnext"/u);
  assert.match(csv, /"safe\.txt","4","plain"/u);
});

test('file-history handoff uses the pinned hash and remains an explicit no-run URL', () => {
  const href = buildContentSearchFileHistoryHref(
    '/project?path=%2Fold&tab=files&investigation=compare&investigationBase=x',
    '/repo',
    HASH,
    'src/example.ts',
    true,
  );
  const url = new URL(href, 'http://localhost');
  assert.equal(url.searchParams.get('path'), '/repo');
  assert.equal(url.searchParams.get('tab'), 'info');
  assert.equal(url.searchParams.get('investigation'), 'file-history');
  assert.equal(url.searchParams.get('investigationRevision'), HASH);
  assert.equal(url.searchParams.get('investigationFile'), 'src/example.ts');
  assert.equal(url.searchParams.get('investigationFollow'), 'true');
  assert.equal(url.searchParams.get('investigationBase'), null);
});

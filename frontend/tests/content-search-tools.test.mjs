import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTENT_SEARCH_SORTS,
  adjacentContentSearchMatches,
  buildContentSearchFileHistoryHref,
  contentSearchContext,
  contentSearchCsv,
  contentSearchFileQuery,
  contentSearchInvestigationMarkdown,
  contentSearchJson,
  contentSearchPathLineList,
  contentSearchPaths,
  contentSearchQuery,
  contentSearchRequestKey,
  contentSearchVisibleMatches,
  filterContentSearchMatches,
  sortContentSearchMatches,
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

const matches = [
  { path: 'src/z.ts', line: 12, text: 'Needle after' },
  { path: 'src/a.ts', line: 4, text: 'needle first' },
  { path: 'src/a.ts', line: 20, text: 'other needle' },
  { path: 'docs/read me.md', line: 2, text: 'unrelated' },
];

test('local content search matches path or text and applies an exact path filter', () => {
  assert.deepEqual(filterContentSearchMatches(matches, 'needle', ''), [matches[0], matches[1], matches[2]]);
  assert.deepEqual(filterContentSearchMatches(matches, 'src', 'src/a.ts'), [matches[1], matches[2]]);
  assert.deepEqual(filterContentSearchMatches(matches, '', 'src/a.ts'), [matches[1], matches[2]]);
  assert.deepEqual(contentSearchPaths(matches), ['src/z.ts', 'src/a.ts', 'docs/read me.md']);
});

test('content result order is stable for Git, path, line, and text modes', () => {
  assert.deepEqual(CONTENT_SEARCH_SORTS.map(({ key }) => key), ['git', 'path', 'line', 'text']);
  assert.deepEqual(sortContentSearchMatches(matches, 'git'), matches);
  assert.deepEqual(sortContentSearchMatches(matches, 'path').map((match) => match.path), ['docs/read me.md', 'src/a.ts', 'src/a.ts', 'src/z.ts']);
  assert.deepEqual(sortContentSearchMatches(matches, 'line').map((match) => match.line), [2, 4, 12, 20]);
  assert.deepEqual(sortContentSearchMatches(matches, 'text').map((match) => match.text), ['Needle after', 'needle first', 'other needle', 'unrelated']);
  assert.deepEqual(contentSearchVisibleMatches(matches, { localQuery: 'needle', pathFilter: 'src/a.ts', sort: 'line' }), [matches[1], matches[2]]);
  assert.notStrictEqual(sortContentSearchMatches(matches, 'path'), matches);
});

test('content navigation never wraps and makes an excluded selection explicit', () => {
  assert.deepEqual(adjacentContentSearchMatches([matches[1], matches[2]], matches[1]), {
    index: 0,
    count: 2,
    previous: null,
    next: matches[2],
  });
  assert.deepEqual(adjacentContentSearchMatches([matches[1], matches[2]], matches[2]).previous, matches[1]);
  assert.deepEqual(adjacentContentSearchMatches([matches[1]], matches[0]), {
    index: -1,
    count: 1,
    previous: null,
    next: null,
  });
});

const exportMetadata = {
  repository_path: '/repo',
  pinned_hash: HASH,
  input: { revision: 'main', query: 'Needle', case_sensitive: false, directory: 'src' },
  coverage: { server_matches: 4, visible_matches: 2, server_truncated: true, server_limit: 1000, server_byte_limit: 4096 },
  local_conditions: { search: 'needle', path: 'src/a.ts', sort: 'line' },
};

test('visible JSON retains pinned input, server coverage, local conditions, and only visible rows', () => {
  const visible = [matches[1], matches[2]];
  const parsed = JSON.parse(contentSearchJson(visible, exportMetadata));
  assert.deepEqual(parsed.repository_path, '/repo');
  assert.equal(parsed.pinned_hash, HASH);
  assert.deepEqual(parsed.input, exportMetadata.input);
  assert.deepEqual(parsed.coverage, exportMetadata.coverage);
  assert.deepEqual(parsed.local_conditions, exportMetadata.local_conditions);
  assert.deepEqual(parsed.matches, visible);
  assert.match(contentSearchPathLineList(visible), /"src\/a\.ts": \[\n    4,\n    20\n  \]/u);
  assert.deepEqual(JSON.parse(contentSearchPathLineList([{ path: 'path\\"\nname', line: 7, text: 'x' }])), { 'path\\"\nname': [7] });
});

test('Markdown investigation report names server query and exact fetched context state', () => {
  const report = contentSearchInvestigationMarkdown(matches[1], exportMetadata, {
    start: 3,
    end: 5,
    lines: [
      { line: 3, text: 'before | line', highlight: false },
      { line: 4, text: 'needle `value`', highlight: true },
      { line: 5, text: 'after', highlight: false },
    ],
  }, { binary: false, text_available: true, truncated: true });
  assert.match(report, /固定ハッシュ:/u);
  assert.match(report, new RegExp(`サーバー検索語: Needle`));
  assert.match(report, /path: src\/a\.ts/u);
  assert.match(report, /行: 4/u);
  assert.match(report, /取得済み本文の切詰め: true/u);
  assert.match(report, /needle `value`/u);
  assert.match(report, /4 \* \| needle `value`/u);
});

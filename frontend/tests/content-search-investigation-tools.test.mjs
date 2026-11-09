import test from 'node:test';
import assert from 'node:assert/strict';
import { contentSearchContext } from '../app/content-search-tools.mjs';
import {
  contentSearchExtension,
  contentSearchExtensions,
  contentSearchExtraConditionsMarkdown,
  contentSearchFileSummaries,
  contentSearchLineRange,
  contentSearchRawContext,
  contentSearchReviewKey,
  filterContentSearchInvestigationMatches,
} from '../app/content-search-investigation-tools.mjs';

const matches = [
  { path: 'src/a.TS', line: 10, text: 'Needle active' },
  { path: 'src/a.TS', line: 20, text: 'Needle deprecated' },
  { path: 'docs/guide.md', line: 2, text: 'Needle active' },
  { path: '.gitignore', line: 4, text: 'Needle generated' },
  { path: 'scripts/check', line: 30, text: 'Needle active' },
];
const conditions = (overrides) => ({ extension: null, lineFrom: '', lineTo: '', excludedQuery: '', hideReviewed: false, reviewedKeys: new Set(), ...overrides });

test('content extensions distinguish extensionless dotfiles and normalize suffix case', () => {
  assert.deepEqual(contentSearchExtensions(matches), ['', '.md', '.ts']);
  assert.equal(contentSearchExtension('.env.local'), '.local');
  assert.equal(contentSearchExtension('trailing.'), '');
  assert.deepEqual(filterContentSearchInvestigationMatches(matches, conditions({ extension: '.ts' })), matches.slice(0, 2));
  assert.deepEqual(filterContentSearchInvestigationMatches(matches, conditions({ extension: '' })), matches.slice(3));
});

test('inclusive content line range accepts explicit empty bounds and excludes invalid input', () => {
  assert.deepEqual(contentSearchLineRange('', ''), { valid: true, minimum: null, maximum: null, error: null });
  assert.deepEqual(filterContentSearchInvestigationMatches(matches, conditions({ lineFrom: '10', lineTo: '20' })), matches.slice(0, 2));
  assert.deepEqual(filterContentSearchInvestigationMatches(matches, conditions({ lineTo: '4' })), matches.slice(2, 4));
  for (const [lineFrom, lineTo] of [['20', '10'], ['0', ''], ['1e2', ''], ['1.5', ''], ['', '9007199254740992']]) {
    assert.equal(contentSearchLineRange(lineFrom, lineTo).valid, false);
    assert.deepEqual(filterContentSearchInvestigationMatches(matches, conditions({ lineFrom, lineTo })), []);
  }
});

test('negative literal search applies to path and text without interpreting expressions', () => {
  assert.deepEqual(filterContentSearchInvestigationMatches(matches, conditions({ excludedQuery: 'DEPRECATED' })), [matches[0], ...matches.slice(2)]);
  assert.deepEqual(filterContentSearchInvestigationMatches(matches, conditions({ excludedQuery: 'docs/' })), [matches[0], matches[1], matches[3], matches[4]]);
  assert.deepEqual(filterContentSearchInvestigationMatches(matches, conditions({ excludedQuery: '.*' })), matches);
});

test('review identity includes source text and filtering removes only marked rows', () => {
  const key = contentSearchReviewKey(matches[0]);
  assert.notEqual(key, contentSearchReviewKey({ ...matches[0], text: 'changed' }));
  const reviewedKeys = new Set([key]);
  assert.deepEqual(filterContentSearchInvestigationMatches(matches, conditions({ reviewedKeys, hideReviewed: true })), matches.slice(1));
  assert.deepEqual(filterContentSearchInvestigationMatches(matches, conditions({ reviewedKeys })), matches);
  reviewedKeys.delete(key);
  assert.deepEqual(filterContentSearchInvestigationMatches(matches, conditions({ reviewedKeys, hideReviewed: true })), matches);
});

test('file summaries use visible rows, inclusive min/max lines and exact percentages', () => {
  const summaries = contentSearchFileSummaries([matches[1], matches[0], matches[2]], new Set([contentSearchReviewKey(matches[0])]));
  assert.deepEqual(summaries, [
    { path: 'src/a.TS', count: 2, firstLine: 10, lastLine: 20, reviewed: 1, percent: 2 / 3 * 100 },
    { path: 'docs/guide.md', count: 1, firstLine: 2, lastLine: 2, reviewed: 0, percent: 1 / 3 * 100 },
  ]);
  assert.deepEqual(contentSearchFileSummaries([], new Set()), []);
});

test('context radius produces exact raw copied context without display line numbers', () => {
  const text = 'before\r\n\tNeedle\r\nafter\r\nlast\r\n';
  assert.equal(contentSearchRawContext(contentSearchContext(text, 2, 0)), '\tNeedle\r');
  assert.equal(contentSearchRawContext(contentSearchContext(text, 2, 1)), 'before\r\n\tNeedle\r\nafter\r');
  assert.equal(contentSearchContext(text, 1, 20).lines.length, 4);
  assert.throws(() => contentSearchRawContext({ lines: [] }), TypeError);
});

test('extra Markdown conditions retain active filters and local review scope', () => {
  const report = contentSearchExtraConditionsMarkdown({ extension: '', line_from: '2', line_to: '', exclude: 'generated', hide_reviewed: true, reviewed_matches: 1 });
  assert.match(report, /拡張子: ""/u);
  assert.match(report, /行範囲: 2–制限なし/u);
  assert.match(report, /"generated"/u);
  assert.match(report, /確認済みを非表示: true/u);
  assert.match(report, /確認済み数: 1/u);
});

test('new content investigation helpers require every parameter explicitly', () => {
  assert.throws(() => contentSearchLineRange(undefined, ''), TypeError);
  assert.throws(() => filterContentSearchInvestigationMatches(matches, { ...conditions({}), extension: undefined }), TypeError);
  assert.throws(() => filterContentSearchInvestigationMatches(matches, { ...conditions({}), hideReviewed: undefined }), TypeError);
  assert.throws(() => contentSearchFileSummaries(matches, undefined), TypeError);
  assert.throws(() => contentSearchRawContext(undefined), TypeError);
});

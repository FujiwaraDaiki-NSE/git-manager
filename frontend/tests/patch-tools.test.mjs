import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePatch } from '../app/parse-patch.mjs';
import { findPatchMatches, selectPatchLines, splitPatchByFile, summarizePatchSection } from '../app/patch-tools.mjs';

test('literal case-sensitive search keeps original Unicode offsets and regex punctuation', () => {
  const text = '+İ before Target target TARGET [a+b]';
  const sections = [{ title: 'unicode', lines: [{ text, kind: 'addition' }] }];
  const insensitive = findPatchMatches(sections, 'target', { caseSensitive: false });
  assert.deepEqual(insensitive.map(m => text.slice(m.offset, m.offset + m.length)), ['Target', 'target', 'TARGET']);
  const sensitive = findPatchMatches(sections, 'Target', { caseSensitive: true });
  assert.equal(sensitive.length, 1);
  assert.equal(sensitive[0].offset, text.indexOf('Target'));
  const literal = findPatchMatches(sections, '[a+b]', { caseSensitive: true });
  assert.equal(literal.length, 1);
  assert.equal(literal[0].offset, text.indexOf('[a+b]'));
  assert.deepEqual(findPatchMatches(sections, '.*', {}), []);
});

test('whole-word mode excludes identifier fragments including Unicode and combining marks', () => {
  const text = '+target targetValue my_target $target target2 target\u0301 𐐀target 日本target (target) target';
  const sections = [{ title: 'words', lines: [{ text, kind: 'addition' }, { text: ' target', kind: 'context' }] }];
  const words = findPatchMatches(sections, 'target', { wholeWord: true, changedOnly: true, sectionIndexes: [0] });
  assert.equal(words.length, 3);
  assert.deepEqual(words.map(m => m.offset), [1, text.indexOf('(target)') + 1, text.lastIndexOf('target')]);
  assert.equal(findPatchMatches(sections, 'target', { wholeWord: true }).length, 4);
  assert.equal(findPatchMatches(sections, 'Target', { wholeWord: true, caseSensitive: true }).length, 0);
  assert.equal(findPatchMatches(sections, 'target', { wholeWord: false }).length, 11);
});

test('per-file chunks preserve the original source, including preamble, CRLF, and final bytes', () => {
  const patch = 'notice\r\ndiff --git a/one.txt b/one.txt\r\n@@ -1 +1 @@\r\n-old\r\n+new\r\ndiff --git a/two.txt b/two.txt\r\nBinary files a/two.txt and b/two.txt differ';
  assert.deepEqual(splitPatchByFile(patch), [
    'notice\r\n',
    'diff --git a/one.txt b/one.txt\r\n@@ -1 +1 @@\r\n-old\r\n+new\r\n',
    'diff --git a/two.txt b/two.txt\r\nBinary files a/two.txt and b/two.txt differ',
  ]);
  assert.equal(splitPatchByFile(patch).join(''), patch);
});

test('change summaries count parsed additions and deletions, excluding headers and binary text', () => {
  const [text, binary] = parsePatch([
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -2,2 +2,3 @@',
    ' context',
    '-old',
    '+new',
    '+added',
    'diff --git a/image.png b/image.png',
    'Binary files a/image.png and b/image.png differ',
  ].join('\n'));
  assert.deepEqual(summarizePatchSection(text), { additions: 2, deletions: 1, binary: false, hasTextLines: true });
  assert.deepEqual(summarizePatchSection(binary), { additions: 0, deletions: 0, binary: true, hasTextLines: false });
});

test('changed-only selection retains hunks, metadata, line numbers, and both change kinds', () => {
  const section = parsePatch('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -5,3 +5,3 @@\n keep\n-old\n+new')[0];
  const lines = selectPatchLines(section.lines, true);
  assert.deepEqual(lines.map((line) => line.kind), ['meta', 'meta', 'meta', 'hunk', 'deletion', 'addition']);
  assert.deepEqual(lines.slice(-2).map((line) => [line.oldLine, line.newLine]), [[6, null], [null, 6]]);
});

test('content search returns every occurrence, honors filename scope and excludes context in changed-only mode', () => {
  const sections = parsePatch([
    'diff --git a/one.txt b/one.txt',
    '@@ -1,2 +1,2 @@',
    ' keep target',
    '-target old',
    '+target target new',
    'diff --git a/two.txt b/two.txt',
    '@@ -1 +1 @@',
    '-other',
    '+target',
  ].join('\n'));
  const all = findPatchMatches(sections, 'target', { changedOnly: false, sectionIndexes: [0, 1] });
  assert.equal(all.length, 5);
  assert.deepEqual(all.map((match) => [match.sectionIndex, match.lineIndex, match.offset]), [
    [0, 2, 6], [0, 3, 1], [0, 4, 1], [0, 4, 8], [1, 3, 1],
  ]);
  const scoped = findPatchMatches(sections, 'target', { changedOnly: true, sectionIndexes: [0] });
  assert.equal(scoped.length, 3);
  assert.ok(scoped.every((match) => match.sectionIndex === 0));
  assert.ok(scoped.every((match) => sections[0].lines[match.lineIndex].kind !== 'context'));
});

test('source row indexes survive context removal and a page boundary', async () => {
  const { selectPatchRows } = await import('../app/patch-tools.mjs');
  const lines = Array.from({ length: 650 }, (_, i) => ({ text: `+target ${i}`, kind: i % 2 ? 'addition' : 'context', oldLine: null, newLine: i + 1 }));
  const rows = selectPatchRows(lines, true);
  assert.equal(rows.length, 325);
  assert.equal(rows[300].lineIndex, 601);
  assert.equal(rows[300].line, lines[601]);
  const matches = findPatchMatches([{title: 'large', lines}], 'target', {changedOnly: true, sectionIndexes: [0]});
  assert.equal(matches[300].lineIndex, rows[300].lineIndex);
  assert.equal(matches[300].id, '0:601:1');
  assert.deepEqual(selectPatchRows(lines, false).map(row => row.line), lines);
});

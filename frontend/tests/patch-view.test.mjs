import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePatch } from '../app/parse-patch.mjs';

test('unified hunks retain exact text and map old/new line numbers', () => {
  const patch = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -4,2 +4,3 @@ title\n same\n-old\n+new\n+added\n\\ No newline at end of file';
  const [section] = parsePatch(patch);
  assert.equal(section.lines.map(l => l.text).join('\n'), patch);
  assert.deepEqual(section.lines.slice(4,8).map(l => [l.kind,l.oldLine,l.newLine]), [
    ['context',4,4], ['deletion',5,null], ['addition',null,5], ['addition',null,6],
  ]);
  assert.equal(section.lines[2].kind, 'meta');
  assert.equal(section.lines.at(-1).oldLine, null);
});

test('new and deleted files, omitted counts and multiple hunks', () => {
  const lines = parsePatch('@@ -0,0 +1,2 @@\n+one\n+two\n@@ -9 +11 @@\n-before\n+after\n@@ -20,2 +0,0 @@\n-a\n-b')[0].lines;
  assert.deepEqual(lines.filter(l => l.kind === 'addition').map(l => l.newLine), [1,2,11]);
  assert.deepEqual(lines.filter(l => l.kind === 'deletion').map(l => l.oldLine), [9,20,21]);
});

test('combined and binary diffs retain content without fabricated two-sided line numbers', () => {
  const patch = 'diff --cc merge.txt\n@@@ -1,1 -1,1 +1,1 @@@\n++merged\ndiff --git a/img b/img\nBinary files a/img and b/img differ\n';
  const sections = parsePatch(patch);
  assert.equal(sections.length, 2);
  assert.equal(sections.flatMap(s => s.lines).map(l => l.text).join('\n'), patch);
  assert.ok(sections.flatMap(s => s.lines).every(l => l.oldLine === null && l.newLine === null));
});

test('empty, truncated and special-character text is preserved', () => {
  assert.deepEqual(parsePatch(''), []);
  const patch = 'diff --git "a/日本 語" "b/日本 語"\n@@ -1 +1,2 @@\n-<script>\n+<b>&';
  assert.equal(parsePatch(patch)[0].lines.map(l => l.text).join('\n'), patch);
});

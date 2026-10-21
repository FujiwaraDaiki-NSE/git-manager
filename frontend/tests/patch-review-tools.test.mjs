import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePatch } from '../app/parse-patch.mjs';
import {
  buildVisiblePatch,
  classifyPatchSection,
  filterPatchReviewEntries,
  patchReviewProgress,
  sortPatchReviewEntries,
} from '../app/patch-review-tools.mjs';

function entries(patch) {
  return parsePatch(patch).map((section, index) => ({ section, index }));
}

test('classifies parsed sections from explicit text and binary evidence', () => {
  const sections = entries([
    'diff --git a/text.txt b/text.txt',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/image.png b/image.png',
    'Binary files a/image.png and b/image.png differ',
    'diff --git a/mode.txt b/mode.txt',
    'old mode 100644',
    'new mode 100755',
  ].join('\n'));
  assert.deepEqual(sections.map(({ section }) => classifyPatchSection(section)), ['text', 'binary', 'other']);
  assert.deepEqual(filterPatchReviewEntries(sections, 'text').map(({ index }) => index), [0]);
  assert.deepEqual(filterPatchReviewEntries(sections, 'binary').map(({ index }) => index), [1]);
  assert.equal(filterPatchReviewEntries(sections, 'all').length, 3);
});

test('sorts by path or total changed lines while retaining original indexes', () => {
  const patch = [
    'diff --git a/z.txt b/z.txt',
    '@@ -1 +1 @@',
    '-z',
    '+z',
    'diff --git a/a.txt b/a.txt',
    '@@ -1,2 +1,4 @@',
    '-a',
    '-old',
    '+a',
    '+new',
    '+more',
    'diff --git a/m.txt b/m.txt',
    '@@ -1 +1 @@',
    '-m',
    '+m',
  ].join('\n');
  const sections = entries(patch);
  assert.deepEqual(sortPatchReviewEntries(sections, 'original').map(({ index }) => index), [0, 1, 2]);
  assert.deepEqual(sortPatchReviewEntries(sections, 'path').map(({ section }) => section.title), ['a.txt', 'm.txt', 'z.txt']);
  assert.deepEqual(sortPatchReviewEntries(sections, 'changes').map(({ index }) => index), [1, 0, 2]);
  assert.throws(() => sortPatchReviewEntries(sections, 'unknown'), /Unknown file sort/);
});

test('keeps binary and metadata-only change totals after measured text changes', () => {
  const sections = entries([
    'diff --git a/binary.bin b/binary.bin',
    'Binary files a/binary.bin and b/binary.bin differ',
    'diff --git a/text.txt b/text.txt',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/mode.txt b/mode.txt',
    'old mode 100644',
    'new mode 100755',
  ].join('\n'));
  assert.deepEqual(sortPatchReviewEntries(sections, 'changes').map(({ index }) => index), [1, 0, 2]);
});

test('exports complete raw chunks in original patch order after a display sort', () => {
  const patch = 'notice\r\ndiff --git a/z.txt b/z.txt\r\n@@ -1 +1 @@\r\n-z\r\n+z\r\ndiff --git a/a.txt b/a.txt\r\n@@ -1 +1 @@\r\n-a\r\n+a';
  const chunks = patch.split(/(?=diff --git )/);
  const sectionEntries = entries(patch);
  const pathSorted = sortPatchReviewEntries(sectionEntries, 'path');
  assert.equal(buildVisiblePatch(chunks, pathSorted), chunks[0] + chunks[1] + chunks[2]);
  assert.equal(buildVisiblePatch(chunks, [pathSorted[0]]), chunks[2]);
  assert.equal(buildVisiblePatch(chunks, []), '');
  assert.throws(() => buildVisiblePatch(chunks, [{ section: sectionEntries[0].section, index: 9 }]), /outside sectionPatches/);
});

test('review progress counts only the current patch indexes', () => {
  assert.deepEqual(patchReviewProgress(3, new Set([0, 2])), { reviewed: 2, total: 3 });
  assert.throws(() => patchReviewProgress(2, new Set([2])), /outside the patch sections/);
  assert.throws(() => patchReviewProgress(2, [0]), /must be a Set/);
});

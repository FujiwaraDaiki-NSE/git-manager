import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import React from 'react';
import ts from 'typescript';
import { parsePatch } from '../app/parse-patch.mjs';
import * as patchTools from '../app/patch-tools.mjs';
import * as patchReviewTools from '../app/patch-review-tools.mjs';
import * as sideBySideTools from '../app/side-by-side.mjs';

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

test('hunk navigation reveals later rows and focuses headings in both layouts', () => {
  const source = new URL('../app/patch-view.tsx', import.meta.url);
  const require = createRequire(source);
  const modules = {
    './parse-patch.mjs': { parsePatch }, './patch-tools.mjs': patchTools,
    './patch-review-tools.mjs': patchReviewTools, './side-by-side.mjs': sideBySideTools,
    './copy-button': {}, './patch-tools.css': {},
  };
  const { outputText } = ts.transpileModule(readFileSync(source, 'utf8') + '\nexport { PatchLines };', {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  });
  const combined = '@@@ -2 -3 +4 @@@ merged';
  const [section] = parsePatch(['@@ -1,302 +1,302 @@ first', ...Array(302).fill(' context'),
    '@@ -421 +459 @@ function review()', '-before', '+after', combined].join('\n'));

  function find(node, predicate) {
    if (!React.isValidElement(node)) return;
    if (predicate(node)) return node;
    for (const child of React.Children.toArray(node.props.children)) {
      const match = find(child, predicate);
      if (match) return match;
    }
  }

  for (const sideBySide of [false, true]) {
    const focus = [];
    const focusRow = { current: null };
    let limit, refs, rendered, afterRender;
    const container = { scrollTop: 0, getBoundingClientRect: () => ({ top: 0 }), querySelector(selector) {
      const index = Number(selector.match(/\d+/)[0]);
      if (!find(rendered, (node) => node.props['data-patch-row'] === index)) return null;
      return { scrollIntoView() {}, getBoundingClientRect: () => ({ top: 2 }), focus: () => focus.push(index) };
    } };
    const hooks = {
      useState: (initial) => [limit ?? initial, (next) => { limit = next; }],
      useRef: () => refs.shift(),
      useMemo: (compute) => compute(),
      useLayoutEffect: (effect) => { afterRender = effect; },
    };
    const exports = {};
    new Function('require', 'exports', outputText)(
      (id) => id === 'react' ? hooks : modules[id] ?? require(id), exports,
    );
    function render() {
      refs = [{ current: container }, focusRow];
      rendered = exports.PatchLines({ section, sideBySide, wrap: false, changedOnly: false, matches: [], activeMatchId: null });
      afterRender();
      return find(rendered, (node) => node.type === 'select');
    }

    let select = render();
    assert.deepEqual(select.props.children[1].map((item) => item.props.children), [
      '1. 旧 1行 / 新 1行 · first', '2. 旧 421行 / 新 459行 · function review()', combined,
    ]);
    assert.equal(find(rendered, (node) => node.props['data-patch-row'] === 303), undefined);
    select.props.onChange({ target: { value: '303' } });
    select = render();
    assert.equal(limit, 600);
    assert.deepEqual(focus, [303]);
    select.props.onChange({ target: { value: '0' } });
    assert.deepEqual(focus, [303, 0]);
  }
});

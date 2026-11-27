import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { parsePatch } from '../app/parse-patch.mjs';
import * as patchTools from '../app/patch-tools.mjs';
import * as patchReviewTools from '../app/patch-review-tools.mjs';
import * as sideBySideTools from '../app/side-by-side.mjs';

test('diff, file and conflict stage searches leave IME Enter to the input and keep match navigation', () => {
  for (const [file, navigate] of [
    ['patch-view', 'goToMatch'],
    ['repository-text-view', 'navigateMatch'],
    ['conflict-inspector', 'goToMatch'],
  ]) {
    const source = readFileSync(new URL(`../app/${file}.tsx`, import.meta.url), 'utf8');
    const tree = ts.createSourceFile(`${file}.tsx`, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function findSearchHandler(node) {
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText() === 'input') {
        const attributes = node.attributes.properties;
        const type = attributes.find((attribute) => attribute.name?.getText() === 'type');
        if (type?.initializer?.getText() === '"search"') {
          return attributes.find((attribute) => attribute.name?.getText() === 'onKeyDown')?.initializer?.expression;
        }
      }
      return ts.forEachChild(node, findSearchHandler);
    }
    const handler = findSearchHandler(tree);
    assert.ok(handler, file);
    const moves = [];
    let prevented = 0;
    const onKeyDown = new Function(navigate, `return (${handler.getText()});`)((direction) => moves.push(direction));
    const pressEnter = (isComposing, shiftKey) => onKeyDown({
      key: 'Enter', nativeEvent: { isComposing }, shiftKey, preventDefault: () => { prevented += 1; },
    });
    pressEnter(true, false);
    assert.deepEqual(moves, [], file);
    assert.equal(prevented, 0, file);
    pressEnter(false, false);
    pressEnter(false, true);
    assert.deepEqual(moves, [1, -1], file);
    assert.equal(prevented, 2, file);
  }
});

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

function loadPatchView(hooks) {
  const source = new URL('../app/patch-view.tsx', import.meta.url);
  const require = createRequire(source);
  const modules = {
    './parse-patch.mjs': { parsePatch }, './patch-tools.mjs': patchTools,
    './patch-review-tools.mjs': patchReviewTools, './side-by-side.mjs': sideBySideTools,
    './copy-button': {}, './patch-tools.css': {},
  };
  const { outputText } = ts.transpileModule(readFileSync(source, 'utf8') + '\nexport { PatchLines, PatchText, FileSummary };', {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  });
  const exports = {};
  new Function('require', 'exports', outputText)(
    (id) => id === 'react' ? hooks : modules[id] ?? require(id), exports,
  );
  return exports;
}

test('combined summaries identify multiple parents and keep ordinary line totals', () => {
  const { FileSummary } = loadPatchView(React);
  const [combined, ordinary] = parsePatch('diff --cc a\n@@@ -1 -1 +1 @@@\n++merged\ndiff --git a/b b/b\n@@ -1 +1 @@\n-old\n+new');
  assert.match(renderToStaticMarkup(FileSummary({ section: combined })), /複数親の差分/);
  assert.match(renderToStaticMarkup(FileSummary({ section: ordinary })), /aria-label="追加 1 行、削除 1 行"/);
});

test('whitespace markers preserve raw text, line prefixes and active search highlights', () => {
  const { PatchText } = loadPatchView(React);
  const patch = [
    'diff --git a/a b/a', '@@ -1 +1 @@\r', '-\r', '+\tleft  right\t \r',
    'diff --combined b', '@@@@ -1 -1 -1 +1 @@@@', ' + \tmerged  ', '   ',
  ].join('\n');
  const [ordinary, combined] = parsePatch(patch);
  const render = (line, showWhitespace, matches = []) => renderToStaticMarkup(PatchText({
    line, showWhitespace, matches, activeMatchId: matches[0]?.id ?? null,
  }));
  assert.equal(render(ordinary.lines[2], false), '-\r');
  assert.match(render(ordinary.lines[2], true), /data-symbol="∅"/);
  const line = ordinary.lines[3];
  const matches = patchTools.findPatchMatches([ordinary], 'left  right', {});
  const markup = render(line, true, matches);
  assert.match(markup, /aria-current="true">left  right<\/mark>/);
  assert.deepEqual([...markup.matchAll(/data-symbol="(.)"/g)].map((match) => match[1]), ['→', '→', '·']);
  assert.equal(markup.replace(/<[^>]+>/g, ''), line.text);
  const tabMatch = patchTools.findPatchMatches([ordinary], '+\tleft', {});
  assert.match(render(line, true, tabMatch), /aria-current="true">\+<span[^>]+data-symbol="→">\t<\/span>left<\/mark>/);
  assert.match(render(combined.lines[2], true), /^ \+ <span[^>]+data-symbol="→"/);
  assert.match(render(combined.lines[3], true), /^ {3}<span[^>]+data-symbol="∅"/);
  assert.equal(render(combined.lines[1], true), combined.lines[1].text);
});

test('hunk navigation reveals later rows and focuses headings in both layouts', () => {
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
    const { PatchLines } = loadPatchView(hooks);
    function render() {
      refs = [{ current: container }, focusRow];
      rendered = PatchLines({ section, sideBySide, wrap: false, changedOnly: false, matches: [], activeMatchId: null, showWhitespace: false });
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

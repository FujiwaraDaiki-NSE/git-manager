import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../app/agent-decision.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputText)(
  (name) => name.endsWith('.css') ? {} : require(name), module, module.exports,
);
const render = (decision, compact = false) => renderToStaticMarkup(React.createElement(module.exports.AgentDecisionDetails, { decision, compact }));

test('decision renders question first, choices and only HTTP(S) links; null renders nothing', () => {
  assert.equal(render(null), '');
  assert.equal(render(undefined), '');
  const html = render({ question: '質問<script>', options: ['進める', '見送る'], links: ['https://example.com/pr', 'http://example.com', 'javascript:alert(1)', '/relative', 'invalid'] });
  assert.match(html, /<strong>質問&lt;script&gt;<\/strong><ul><li>進める<\/li><li>見送る<\/li>/);
  assert.equal((html.match(/<a /g) ?? []).length, 2);
  assert.match(html, /href="https:\/\/example.com\/pr"/);
  assert.doesNotMatch(html, /href="(?:javascript:|\/relative|invalid)/);
});

test('compact decision shows the full question as title and option count without details', () => {
  const question = 'ホームカードで確認する長い質問。'.repeat(10) + '<確認>';
  const html = render({ question, options: ['進める', '見送る'], links: ['https://example.com/pr'] }, true);
  assert.match(html, /class="agent-decision agent-decision-compact"/);
  assert.ok(html.includes(`title="${question.replace('<確認>', '&lt;確認&gt;')}"`));
  assert.match(html, /選択肢 2件/);
  assert.doesNotMatch(html, /<ul>|<a /);
  assert.match(render({ question: '自由回答', options: [], links: [] }, true), /選択肢 0件/);
  assert.equal(render(null, true), '');
  assert.equal(render(undefined, true), '');
});

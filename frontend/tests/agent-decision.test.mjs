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
const render = (decision) => renderToStaticMarkup(React.createElement(module.exports.AgentDecisionDetails, { decision }));

test('decision renders question first, choices and only HTTP(S) links; null renders nothing', () => {
  assert.equal(render(null), '');
  assert.equal(render(undefined), '');
  const html = render({ question: '質問<script>', options: ['進める', '見送る'], links: ['https://example.com/pr', 'http://example.com', 'javascript:alert(1)', '/relative', 'invalid'] });
  assert.match(html, /<strong>質問&lt;script&gt;<\/strong><ul><li>進める<\/li><li>見送る<\/li>/);
  assert.equal((html.match(/<a /g) ?? []).length, 2);
  assert.match(html, /href="https:\/\/example.com\/pr"/);
  assert.doesNotMatch(html, /href="(?:javascript:|\/relative|invalid)/);
});

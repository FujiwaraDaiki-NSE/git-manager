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
const CopyButton = ({ value, label }) => React.createElement('button', { 'data-value': value }, label);
new Function('require', 'module', 'exports', compiled.outputText)(
  (name) => {
    if (name.endsWith('.css')) return {};
    if (name === './copy-button') return { default: CopyButton };
    if (name === 'react') return { useState: (initial) => React.useState(testAnswer ?? initial) };
    return require(name);
  }, module, module.exports,
);
let testAnswer;
const render = (decision, compact = false, replyTarget) => renderToStaticMarkup(React.createElement(module.exports.AgentDecisionDetails, { decision, compact, replyTarget }));
const replyTarget = { projectId: '/workspace/one', branch: 'feature/reply', worktree: '/workspace/one-worktree' };

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
  assert.doesNotMatch(html, /<ul>|<a |判断依頼をコピー|<button/);
  assert.match(render({ question: '自由回答', options: [], links: [] }, true), /選択肢 0件/);
  assert.equal(render(null, true), '');
  assert.equal(render(undefined, true), '');
});

test('decision copy includes question, optional choices and links on separate lines', () => {
  const html = render({ question: 'どう進める？', options: ['進める', '見送る'], links: ['https://example.com/pr', 'https://example.com/docs'] });
  assert.ok(html.includes('data-value="どう進める？\n進める\n見送る\nhttps://example.com/pr\nhttps://example.com/docs"'));
  assert.match(html, />判断依頼をコピー<\/button>/);
  assert.ok(render({ question: '自由回答', options: [], links: [] }).includes('data-value="自由回答"'));
});

test('current decisions allow selecting an option or writing an answer, including without choices', () => {
  const decision = { question: 'どう進める？', options: ['進める', '見送る'], links: [] };
  const current = render(decision, false, replyTarget);
  assert.match(current, /<button[^>]*>見送る<\/button>/);
  assert.match(current, /<label>回答<textarea/);
  assert.doesNotMatch(current, /返答文をコピー/);
  assert.match(render({ ...decision, options: [] }, false, replyTarget), /<label>回答<textarea/);
  assert.doesNotMatch(render(decision), /<textarea|返答文をコピー/);
});

test('reply copy identifies the reported project, branch and worktree', () => {
  const decision = { question: 'どう進める？', options: [], links: [] };
  testAnswer = '進める';
  try {
    assert.ok(render(decision, false, replyTarget).includes(
      'data-value="プロジェクト: /workspace/one\nブランチ: feature/reply\n報告時のパス: /workspace/one-worktree\n質問: どう進める？\n回答: 進める"',
    ));
    assert.ok(render(decision, false, { ...replyTarget, worktree: null }).includes(
      '\n報告時のパス未取得\n質問: どう進める？',
    ));
  } finally {
    testAnswer = undefined;
  }
});

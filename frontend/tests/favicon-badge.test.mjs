import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

test('favicon shows the supplied waiting count, restores the base at zero and rejects an obsolete image load', () => {
  const code = ts.transpileModule(readFileSync(new URL('../app/favicon-badge.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const icon = { href: '/favicon.svg', type: 'image/svg+xml' };
  const images = [], labels = [];
  let effect;
  const context = { drawImage() {}, beginPath() {}, roundRect() {}, fill() {}, measureText: () => ({ width: 10 }), fillText: label => labels.push(label) };
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    require: name => name === "react" ? { useEffect: callback => { effect = callback; } } : { usePathname: () => "/", useSearchParams: () => ({ get: () => null }) },
    document: { querySelector: () => icon, createElement: () => ({ getContext: () => context, toDataURL: () => `data:image/png;${labels.at(-1)}` }) },
    Image: class { constructor() { images.push(this); } },
  });
  exports.default({ waiting: 7 });
  const cleanupSeven = effect();
  cleanupSeven();
  exports.default({ waiting: 0 });
  const cleanupZero = effect();
  images[0].onload();
  assert.deepEqual(labels, []);
  assert.equal(icon.href, '/favicon.svg');
  cleanupZero();
  exports.default({ waiting: 12 });
  const cleanupTwelve = effect();
  images[1].onload();
  assert.deepEqual(labels, ['12']);
  assert.equal(icon.href, 'data:image/png;12');
  assert.equal(icon.type, 'image/png');
  cleanupTwelve();
  assert.equal(icon.href, '/favicon.svg');
  assert.equal(icon.type, 'image/svg+xml');
});

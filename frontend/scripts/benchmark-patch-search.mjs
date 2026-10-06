// Run from the repository: node frontend/scripts/benchmark-patch-search.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { findPatchMatches as after } from '../app/patch-tools.mjs';

const original = execFileSync('git', ['show', '6ab31fd:frontend/app/patch-tools.mjs'], { encoding: 'utf8' });
const { findPatchMatches: before } = await import(`data:text/javascript;base64,${Buffer.from(original).toString('base64')}`);
const sections = [{ title: 'large.txt', lines: Array.from({ length: 20000 }, (_, i) => ({
  text: `+target target ${i}`, kind: i % 3 === 0 ? 'context' : 'addition', oldLine: null, newLine: i + 1,
})) }];
const options = { changedOnly: true, sectionIndexes: [0] };
assert.deepEqual(after(sections, 'target', options), before(sections, 'target', options));
function median(fn) {
  fn(sections, 'target', options);
  const times = [];
  for (let i = 0; i < 7; i += 1) {
    const start = performance.now();
    fn(sections, 'target', options);
    times.push(performance.now() - start);
  }
  return times.sort((a, b) => a - b)[3];
}
const beforeMedianMs = median(before), afterMedianMs = median(after);
console.log(JSON.stringify({ sourceLines: 20000, matches: after(sections, 'target', options).length,
  runs: 7, beforeMedianMs, afterMedianMs, speedup: beforeMedianMs / afterMedianMs }, null, 2));

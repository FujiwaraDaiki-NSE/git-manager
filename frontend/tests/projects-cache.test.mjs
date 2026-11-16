import test from 'node:test';
import assert from 'node:assert/strict';
import { PROJECTS_CACHE_KEY, readProjectsCache, saveProjectsCache } from '../app/projects-cache.mjs';

test('projects response and successful fetch time round trip, including empty list', () => {
  let raw = null;
  const storage = { getItem: (key) => { assert.equal(key, PROJECTS_CACHE_KEY); return raw; }, setItem: (key, value) => { assert.equal(key, PROJECTS_CACHE_KEY); raw = value; } };
  assert.equal(readProjectsCache(storage), null);
  for (const projects of [[], [{ id: 'p', name: 'project' }]]) {
    const response = { projects };
    saveProjectsCache(storage, response, 1234);
    assert.deepEqual(readProjectsCache(storage), { version: 1, savedAt: 1234, response });
  }
});
test('incompatible version, malformed data and unavailable storage are ignored', () => {
  for (const raw of ['{', JSON.stringify({ version: 0, savedAt: 1234, response: { projects: [] } }), JSON.stringify({ version: 1, savedAt: null, response: { projects: [] } }), JSON.stringify({ version: 1, savedAt: 1234, response: {} })]) {
    assert.equal(readProjectsCache({ getItem: () => raw }), null);
  }
  assert.equal(readProjectsCache({ getItem() { throw new Error('denied'); } }), null);
  assert.doesNotThrow(() => saveProjectsCache({ setItem() { throw new Error('quota'); } }, { projects: [] }, 1234));
});

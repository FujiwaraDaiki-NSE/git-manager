import test from "node:test";
import assert from "node:assert/strict";
import {
  addInvestigationPreset,
  buildInvestigationShareUrl,
  createInvestigationPreset,
  deleteInvestigationPreset,
  emptyInvestigationStore,
  mergeInvestigationStores,
  normalizeInvestigationStore,
  parseInvestigationBackup,
  parseInvestigationUrl,
  readInvestigationStore,
  renameInvestigationPreset,
  serializeInvestigationBackup,
  writeInvestigationStore,
} from "../app/investigation-presets-tools.mjs";

class MemoryStorage {
  #values = new Map();
  getItem(key) { return this.#values.has(key) ? this.#values.get(key) : null; }
  setItem(key, value) { this.#values.set(key, String(value)); }
}

const compareValues = { base: "main", target: "feature", mode: "direct" };
const historyValues = { revision: "HEAD", file: " spaced.txt ", follow: true };

test("share URLs keep project state and select only the explicit investigation input", () => {
  const href = "https://gitdash.test/project?path=%2Frepo&tab=info&range=7d&investigation=compare&investigationBase=old&investigationTarget=old2&investigationMode=direct#branch-relations-title";
  const shared = buildInvestigationShareUrl(href, "compare", compareValues);
  const url = new URL(shared);
  assert.equal(url.searchParams.get("path"), "/repo");
  assert.equal(url.searchParams.get("tab"), "info");
  assert.equal(url.searchParams.get("range"), "7d");
  assert.equal(url.hash, "#branch-relations-title");
  assert.equal(url.searchParams.get("investigation"), "compare");
  assert.equal(url.searchParams.get("investigationBase"), "main");
  assert.equal(url.searchParams.get("investigationTarget"), "feature");
  assert.deepEqual(parseInvestigationUrl(url.search), { kind: "compare", values: compareValues, error: null, owner: "compare" });
});

test("URL parsing rejects missing, unknown, mixed, and invalid values without fallback", () => {
  assert.match(parseInvestigationUrl("?investigation=compare&investigationBase=main&investigationMode=direct").error, /Target|target/);
  assert.match(parseInvestigationUrl("?investigation=compare&investigationBase=main&investigationTarget=feature&investigationMode=direct&investigationMystery=x").error, /不明/);
  assert.match(parseInvestigationUrl("?investigation=file-history&investigationRevision=HEAD&investigationFile=src%2Fa&investigationFollow=yes").error, /true または false/);
  assert.match(parseInvestigationUrl("?investigation=compare&investigationBase=main&investigationTarget=feature&investigationMode=direct&investigationRevision=HEAD").error, /対象と一致/);
  assert.equal(parseInvestigationUrl("?investigation=compare&investigationBase=main&investigationTarget=feature&investigationMode=unknown").values, null);
  assert.equal(parseInvestigationUrl("?investigation=file-history&investigationRevision=HEAD&investigationFile=%20spaced.txt%20&investigationFollow=true").values.file, " spaced.txt ");
});

test("repository stores are versioned, scoped by path, and support rename/delete", () => {
  const storage = new MemoryStorage();
  const first = addInvestigationPreset(emptyInvestigationStore(), "compare", compareValues, "Release diff", 10);
  const second = addInvestigationPreset(first, "file-history", historyValues, "Rename trace", 11);
  const saved = writeInvestigationStore(storage, "/repo", second);
  assert.equal(saved.ok, true);
  assert.equal(readInvestigationStore(storage, "/other").store.presets.length, 0);
  const loaded = readInvestigationStore(storage, "/repo");
  assert.equal(loaded.error, null);
  assert.deepEqual(loaded.store, second);
  const renamed = renameInvestigationPreset(second, second.presets[0].id, "Release diff renamed", 12);
  const deleted = deleteInvestigationPreset(renamed, second.presets[1].id);
  assert.deepEqual(deleted.presets.map((preset) => preset.name), ["Release diff renamed"]);
});

test("corrupt local data is reported and cannot be overwritten", () => {
  const storage = new MemoryStorage();
  const key = "gitdash.investigation-presets.v1:%2Frepo";
  storage.setItem(key, "{broken");
  const loaded = readInvestigationStore(storage, "/repo");
  assert.equal(loaded.store.presets.length, 0);
  assert.match(loaded.error, /JSON|壊れ/);
  const result = writeInvestigationStore(storage, "/repo", addInvestigationPreset(emptyInvestigationStore(), "compare", compareValues, "keep", 1));
  assert.equal(result.ok, false);
  assert.equal(storage.getItem(key), "{broken");
});

test("concurrent callers reject a stale snapshot instead of losing the other caller's preset", () => {
  const storage = new MemoryStorage();
  const first = addInvestigationPreset(emptyInvestigationStore(), "compare", compareValues, "first", 1, "first");
  const committed = writeInvestigationStore(storage, "/repo", first, null);
  assert.equal(committed.ok, true);
  const staleRaw = committed.raw;
  const second = addInvestigationPreset(first, "file-history", historyValues, "second", 2, "second");
  const secondCommitted = writeInvestigationStore(storage, "/repo", second, staleRaw);
  assert.equal(secondCommitted.ok, true);
  const staleThird = addInvestigationPreset(first, "compare", { ...compareValues, target: "other" }, "third", 3, "third");
  const rejected = writeInvestigationStore(storage, "/repo", staleThird, staleRaw);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /更新/);
  assert.deepEqual(readInvestigationStore(storage, "/repo").store, second);
});

test("backup import rejects conflicts and dedupes only exact matches", () => {
  const current = addInvestigationPreset(emptyInvestigationStore(), "compare", compareValues, "same", 1, "current");
  const duplicate = createInvestigationPreset("compare", compareValues, "same", 2, "incoming");
  const duplicateStore = normalizeInvestigationStore({ version: 1, presets: [duplicate] });
  assert.throws(() => mergeInvestigationStores(current, duplicateStore, "reject"), /衝突/);
  const deduped = mergeInvestigationStores(current, duplicateStore, "dedupe");
  assert.equal(deduped.added, 0);
  assert.equal(deduped.skipped, 1);
  const changed = normalizeInvestigationStore({ version: 1, presets: [createInvestigationPreset("compare", { ...compareValues, target: "other" }, "same", 2, "incoming-2")] });
  assert.throws(() => mergeInvestigationStores(current, changed, "dedupe"), /衝突/);
  const backup = serializeInvestigationBackup(current);
  assert.deepEqual(parseInvestigationBackup(backup), current);
  assert.throws(() => parseInvestigationBackup("{\"version\":2,\"presets\":[]}"), /version/);
  assert.throws(() => parseInvestigationBackup(JSON.stringify({
    version: 1,
    presets: [{ id: "too-long", name: "n", kind: "compare", values: { base: "a".repeat(513), target: "b", mode: "direct" }, createdAt: 1, updatedAt: 1 }],
  })), /512/);
});

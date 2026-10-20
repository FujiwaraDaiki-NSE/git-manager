import assert from "node:assert/strict";
import test from "node:test";
import {
  CONFLICT_STAGE_BASE,
  CONFLICT_STAGE_OURS,
  CONFLICT_STAGE_THEIRS,
  conflictBase64ToBytes,
  conflictComparisonAvailability,
  conflictDownloadName,
  conflictInventoryCsv,
  conflictInventoryQuery,
  conflictStageAvailability,
  conflictStageHash,
  conflictStageLabel,
  conflictStageQuery,
  conflictComparisonQuery,
} from "../app/conflict-inspector-tools.mjs";

const hash = (letter) => letter.repeat(40);
const files = [
  {
    path: "odd\tname\n.txt",
    base: { stage: 1, hash: hash("a"), mode: "100644", type: "blob", kind: "file", size: 4 },
    ours: { stage: 2, hash: hash("b"), mode: "100644", type: "blob", kind: "file", size: 5 },
    theirs: { stage: 3, hash: hash("c"), mode: "100644", type: "blob", kind: "file", size: 6 },
    stages: {
      "1": { stage: 1, hash: hash("a"), mode: "100644", type: "blob", kind: "file", size: 4 },
      "2": { stage: 2, hash: hash("b"), mode: "100644", type: "blob", kind: "file", size: 5 },
      "3": { stage: 3, hash: hash("c"), mode: "100644", type: "blob", kind: "file", size: 6 },
    },
    missing_stages: [],
  },
  {
    path: "new.txt",
    base: null,
    ours: { stage: 2, hash: hash("d"), mode: "100644", type: "blob", kind: "file", size: 1 },
    theirs: { stage: 3, hash: hash("e"), mode: "100644", type: "blob", kind: "file", size: 1 },
    stages: {},
    missing_stages: [1],
  },
];

test("conflict query helpers keep every API input explicit", () => {
  assert.equal(conflictInventoryQuery("/repo"), "path=%2Frepo");
  assert.equal(conflictStageQuery("/repo", "odd\tname\n.txt", 2, hash("b")), `path=%2Frepo&file=odd%09name%0A.txt&stage=2&expectedHash=${hash("b")}`);
  assert.equal(conflictComparisonQuery("/repo", "conflict.txt", hash("b"), hash("c")), `path=%2Frepo&file=conflict.txt&oursHash=${hash("b")}&theirsHash=${hash("c")}`);
  assert.throws(() => conflictInventoryQuery(), /path/);
  assert.throws(() => conflictStageQuery("/repo", "file", 4, hash("b")), /stage/);
  assert.throws(() => conflictStageQuery("/repo", "file", 2, "HEAD"), /hash/);
  assert.throws(() => conflictComparisonQuery("/repo", "file", hash("b"), undefined), /theirsHash/);
});

test("stage labels, hashes, and availability keep missing or non-file stages explicit", () => {
  assert.equal(conflictStageLabel(CONFLICT_STAGE_BASE), "BASE");
  assert.equal(conflictStageLabel(CONFLICT_STAGE_OURS), "OURS");
  assert.equal(conflictStageLabel(CONFLICT_STAGE_THEIRS), "THEIRS");
  assert.equal(conflictStageHash(files[0], 2), hash("b"));
  assert.equal(conflictStageHash(files[1], 1), null);
  assert.deepEqual(conflictStageAvailability(files[1], 1), { available: false, reason: "BASE のINDEX stageがありません。" });
  assert.equal(conflictComparisonAvailability(files[0]).available, true);
  const addAdd = { ...files[1], stages: { "2": files[1].ours, "3": files[1].theirs } };
  assert.equal(conflictComparisonAvailability(addAdd).available, true);
  const symlink = {
    ...files[0],
    ours: { ...files[0].ours, kind: "symlink", mode: "120000" },
    stages: { ...files[0].stages, "2": { ...files[0].ours, kind: "symlink", mode: "120000" } },
  };
  assert.equal(conflictStageAvailability(symlink, 2).available, false);
  assert.equal(conflictComparisonAvailability(symlink).available, false);
});

test("inventory CSV preserves odd paths and protects formula prefixes", () => {
  const csv = conflictInventoryCsv([
    { ...files[0], path: "=HYPERLINK(\"x\")" },
    { ...files[1], path: "+danger" },
    files[0],
  ]);
  assert.match(csv, /^\uFEFF"path","base_hash"/u);
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/u);
  assert.match(csv, /"'\+danger"/u);
  assert.match(csv, /"odd\tname\n\.txt"/u);
  assert.ok(csv.endsWith("\r\n"));
  assert.throws(() => conflictInventoryCsv(null), /files/);
});

test("base64 downloads retain exact binary bytes and names are filesystem safe", () => {
  assert.deepEqual(Array.from(conflictBase64ToBytes("AAH/")), [0, 1, 255]);
  assert.throws(() => conflictBase64ToBytes("not base64!"), /base64/);
  assert.equal(conflictDownloadName("dir/a\n?.bin", CONFLICT_STAGE_THEIRS, "bin"), "gitdash-conflict-theirs-a__.bin.bin");
});

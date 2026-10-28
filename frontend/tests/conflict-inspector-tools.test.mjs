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
  CONFLICT_TEXT_PAGE_LINES,
  adjacentConflictFile,
  conflictFileExtension,
  conflictFileKind,
  conflictFileMaximumSize,
  conflictFileReport,
  conflictInventoryExtensions,
  conflictStageFacts,
  conflictTextPage,
  filterConflictFiles,
  findConflictTextMatches,
  sortConflictFiles,
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

function fileWithStages(path, stages) {
  return { path, stages, missing_stages: [1, 2, 3].filter((stage) => !Object.hasOwn(stages, String(stage))) };
}

const oursRecord = files[0].stages["2"];
const allStages = files[0].stages;

test("conflict kinds describe every exact index topology including deletion direction", () => {
  const cases = [
    [{ "1": allStages["1"], "2": allStages["2"], "3": allStages["3"] }, "both-modified"],
    [{ "2": allStages["2"], "3": allStages["3"] }, "both-added"],
    [{ "1": allStages["1"], "3": allStages["3"] }, "ours-deleted"],
    [{ "1": allStages["1"], "2": allStages["2"] }, "theirs-deleted"],
    [{ "1": allStages["1"] }, "both-deleted"],
    [{ "2": allStages["2"] }, "ours-added"],
    [{ "3": allStages["3"] }, "theirs-added"],
    [{}, "unknown"],
  ];
  for (const [stages, key] of cases) assert.equal(conflictFileKind(fileWithStages("file", stages)).key, key);
  assert.match(conflictFileKind(fileWithStages("gone", { "1": allStages["1"], "2": allStages["2"] })).description, /THEIRSはありません/u);
});

test("inventory lookup combines literal path terms, exact extension and index topology", () => {
  const inventory = [
    fileWithStages("src/Alert.TEST.TS", allStages),
    fileWithStages("src/alert.tsx", { "2": oursRecord }),
    fileWithStages("docs/alert.ts", { "2": oursRecord, "3": allStages["3"] }),
    fileWithStages("src/.env", allStages),
    fileWithStages("src/README", allStages),
  ];
  const options = { query: "SRC alert", extension: ".ts", kind: "both-modified" };
  assert.deepEqual(filterConflictFiles(inventory, options).map((file) => file.path), ["src/Alert.TEST.TS"]);
  assert.equal(filterConflictFiles(inventory, { ...options, query: "unknown" }).length, 0);
  assert.deepEqual(filterConflictFiles(inventory, { query: "src", extension: "", kind: null }).map((file) => file.path), ["src/.env", "src/README"]);
  assert.equal(filterConflictFiles(inventory, { query: "", extension: null, kind: "both-added" })[0].path, "docs/alert.ts");
  assert.equal(filterConflictFiles(inventory, { query: "", extension: null, kind: null }).length, inventory.length);
  assert.throws(() => filterConflictFiles(inventory, { query: "", extension: undefined, kind: null }), /extension/u);
  assert.throws(() => filterConflictFiles(inventory, { query: "", extension: null, kind: "deleted" }), /kind/u);
});

test("extension options distinguish hidden and extensionless files without matching suffix fragments", () => {
  const inventory = ["src/a.TS", "src/b.tsx", ".env", ".config.json", "README", "trailing."].map((path) => fileWithStages(path, allStages));
  assert.deepEqual(conflictInventoryExtensions(inventory), ["", ".json", ".ts", ".tsx"]);
  assert.equal(conflictFileExtension(inventory[0]), ".ts");
  assert.deepEqual(filterConflictFiles(inventory, { query: "", extension: ".ts", kind: null }).map((file) => file.path), ["src/a.TS"]);
  assert.equal(conflictFileExtension(inventory[2]), "");
});

test("ordering uses the largest present stage, deterministic path ties and unknown sizes last", () => {
  const small = fileWithStages("b.txt", { "2": { ...oursRecord, size: 10 } });
  const sameSize = fileWithStages("a.txt", { "2": { ...oursRecord, size: 10 } });
  const largeBase = fileWithStages("c.txt", { "1": { ...allStages["1"], size: 200 }, "2": { ...oursRecord, size: 1 } });
  const unknown = fileWithStages("0-unknown", { "2": { ...oursRecord, size: null } });
  const inventory = [small, unknown, largeBase, sameSize];
  assert.equal(conflictFileMaximumSize(largeBase), 200);
  assert.equal(conflictFileMaximumSize(unknown), null);
  assert.deepEqual(sortConflictFiles(inventory, "size-desc").map((file) => file.path), ["c.txt", "a.txt", "b.txt", "0-unknown"]);
  assert.deepEqual(sortConflictFiles(inventory, "size-asc").map((file) => file.path), ["a.txt", "b.txt", "c.txt", "0-unknown"]);
  assert.deepEqual(sortConflictFiles(inventory, "path-desc").map((file) => file.path), ["c.txt", "b.txt", "a.txt", "0-unknown"]);
  assert.deepEqual(inventory.map((file) => file.path), ["b.txt", "0-unknown", "c.txt", "a.txt"]);
  assert.throws(() => sortConflictFiles(inventory, undefined), /order/u);
});

test("file navigation follows the supplied filtered ordering without wrapping or replacing hidden selection", () => {
  const inventory = ["c.txt", "a.txt", "b.txt"].map((path) => fileWithStages(path, allStages));
  assert.equal(adjacentConflictFile(inventory, "a.txt", -1), "c.txt");
  assert.equal(adjacentConflictFile(inventory, "a.txt", 1), "b.txt");
  assert.equal(adjacentConflictFile(inventory, "c.txt", -1), null);
  assert.equal(adjacentConflictFile(inventory, "b.txt", 1), null);
  assert.equal(adjacentConflictFile(inventory, "hidden.txt", 1), null);
  assert.equal(adjacentConflictFile([], "a.txt", 1), null);
  assert.throws(() => adjacentConflictFile(inventory, "a.txt", 0), /direction/u);
});

test("metadata diagnostics keep equal objects and differing modes separate", () => {
  const sameBlobDifferentMode = fileWithStages("executable", {
    "1": { ...oursRecord, mode: "100644" },
    "2": { ...oursRecord, hash: hash("b").toUpperCase(), mode: "100755" },
    "3": { ...oursRecord, hash: hash("c"), mode: "100644" },
  });
  const facts = conflictStageFacts(sameBlobDifferentMode);
  assert.ok(facts.some((fact) => fact.includes("BASEとOURSのオブジェクトは同じ") && fact.includes("modeは異なります")));
  assert.ok(facts.some((fact) => fact.includes("OURSとTHEIRSはオブジェクトとmodeが異なります")));
  assert.deepEqual(conflictStageFacts(fileWithStages("missing", { "2": oursRecord })), []);
  assert.deepEqual(conflictStageFacts(fileWithStages("all-different", allStages)), []);
});

test("selected report preserves exact snapshot paths, missing stages and safely quoted read-only commands", () => {
  const file = fileWithStages("odd'`\nname.txt", { "1": allStages["1"], "2": oursRecord });
  const report = conflictFileReport("/repo/it's", file, "snapshot-1", true);
  assert.ok(report.includes('file: "odd\'`\\nname.txt"'));
  assert.match(report, /THEIRS: INDEX stageなし/u);
  assert.match(report, /取得一覧は上限で切り詰められています/u);
  assert.ok(report.includes("git -C '/repo/it'\\''s' --literal-pathspecs --no-pager ls-files --unmerged -- 'odd'\\''`\nname.txt'"));
  assert.ok(report.includes(`cat-file -p '${hash("b")}'`));
  assert.ok(!report.includes("checkout"));
  assert.throws(() => conflictFileReport("/repo", file, undefined, false), /snapshotKey/u);
  assert.throws(() => conflictFileReport("/repo", file, "snapshot", undefined), /truncated/u);
});

test("report fences remain valid for a path containing Markdown closing fences", () => {
  const file = fileWithStages("```danger.txt", { "2": oursRecord });
  const report = conflictFileReport("/repo", file, "snapshot", false);
  assert.ok(report.includes("````text\n"));
  assert.ok(report.includes("````sh\n"));
});

test("stage text search is literal, case-aware and retains precise line and character offsets", () => {
  const text = "Alpha .[\nalpha ALPHA\n日本語 Alpha";
  const options = { caseSensitive: false, limit: 20 };
  const result = findConflictTextMatches(text, "alpha", options);
  assert.equal(result.total, 4);
  assert.deepEqual(result.matches.map(({ line, offset }) => [line, offset]), [[1, 0], [2, 0], [2, 6], [3, 4]]);
  assert.equal(findConflictTextMatches(text, "Alpha", { ...options, caseSensitive: true }).total, 2);
  assert.deepEqual(findConflictTextMatches(text, ".[", options).matches.map(({ line, offset, length }) => [line, offset, length]), [[1, 6, 2]]);
  assert.deepEqual(findConflictTextMatches(text, "", options), { matches: [], total: 0, truncated: false });
  assert.equal(findConflictTextMatches(text, "missing", options).total, 0);
});

test("stage search bounds stored highlights while counting matches beyond the first display page", () => {
  const text = [...Array.from({ length: 350 }, () => "line"), "target target target"].join("\n");
  const result = findConflictTextMatches(text, "target", { caseSensitive: false, limit: 2 });
  assert.equal(result.total, 3);
  assert.equal(result.matches.length, 2);
  assert.equal(result.matches[0].line, 351);
  assert.equal(result.truncated, true);
  assert.throws(() => findConflictTextMatches(text, "target", { caseSensitive: false }), /limit/u);
  assert.throws(() => findConflictTextMatches(text, "target", { limit: 2 }), /caseSensitive/u);
});

test("a late match in a valid large blob renders one bounded page with absolute source lines", () => {
  const text = `${"\n".repeat(500000)}target\nlast`;
  assert.ok(Buffer.byteLength(text) < 1024 * 1024);
  const lines = text.split("\n");
  const result = findConflictTextMatches(text, "target", { caseSensitive: false, limit: 2000 });
  assert.equal(result.matches[0].line, 500001);
  const page = conflictTextPage(lines.length, result.matches[0].line);
  const rendered = lines.slice(page.start, page.end);
  assert.ok(page.start > 499000);
  assert.ok(rendered.length <= CONFLICT_TEXT_PAGE_LINES);
  assert.equal(rendered[result.matches[0].line - page.start - 1], "target");
  assert.equal(page.end, lines.length);
  assert.deepEqual(conflictTextPage(lines.length, 1), { start: 0, end: CONFLICT_TEXT_PAGE_LINES });
});

test("source pages preserve the fixed row bound at page boundaries and require an explicit valid line", () => {
  assert.deepEqual(conflictTextPage(601, 300), { start: 0, end: 300 });
  assert.deepEqual(conflictTextPage(601, 301), { start: 300, end: 600 });
  assert.deepEqual(conflictTextPage(601, 601), { start: 600, end: 601 });
  assert.throws(() => conflictTextPage(601, undefined), /lineNumber/u);
  assert.throws(() => conflictTextPage(601, 602), /lineNumber/u);
  assert.throws(() => conflictTextPage(0, 1), /lineCount/u);
});

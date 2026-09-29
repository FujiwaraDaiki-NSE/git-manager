import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCommitFilesTsv,
  commitFileChangeVolume,
  countCommitFileKinds,
  filterCommitFiles,
  searchCommitFiles,
  sortCommitFiles,
  summarizeCommitFiles,
} from "../app/commit-file-tools.mjs";

const textFile = (path, additions, deletions, old_path) => ({
  path,
  additions,
  deletions,
  binary: false,
  ...(old_path === undefined ? {} : { old_path }),
});

test("path search includes both the current and renamed path", () => {
  const files = [textFile("src/new-name.ts", 3, 1, "src/old-name.ts"), textFile("README.md", 1, 0)];
  assert.deepEqual(searchCommitFiles(files, "OLD-NAME"), [files[0]]);
  assert.deepEqual(searchCommitFiles(files, "readme"), [files[1]]);
  assert.deepEqual(searchCommitFiles(files, ""), files);
});

test("kind counts and filters keep binary and renamed files discoverable", () => {
  const files = [
    textFile("src/new.ts", 4, 2, "src/old.ts"),
    { path: "assets/logo.png", additions: "-", deletions: "-", binary: true },
    textFile("README.md", 1, 0),
  ];
  assert.deepEqual(countCommitFileKinds(files), { all: 3, text: 2, binary: 1, renamed: 1 });
  assert.deepEqual(filterCommitFiles(files, "binary").map((file) => file.path), ["assets/logo.png"]);
  assert.deepEqual(filterCommitFiles(files, "renamed").map((file) => file.path), ["src/new.ts"]);
  assert.deepEqual(filterCommitFiles(files, "text").map((file) => file.path), ["src/new.ts", "README.md"]);
});

test("volume sorting keeps unknown binary changes separate from measured zero", () => {
  const files = [
    { path: "binary.dat", additions: "-", deletions: "-", binary: true },
    textFile("small.ts", 1, 0),
    textFile("large.ts", 8, 4),
  ];
  assert.equal(commitFileChangeVolume(files[0]), null);
  assert.deepEqual(sortCommitFiles(files, "volume", "desc").map((file) => file.path), ["large.ts", "small.ts", "binary.dat"]);
  assert.deepEqual(summarizeCommitFiles(files), {
    files: 3,
    additions: 9,
    deletions: 4,
    binary: 1,
    renamed: 0,
    unknownAdditions: true,
    unknownDeletions: true,
  });
});

test("TSV export escapes spreadsheet formulas, keeps rename data, and marks binary counts unknown", () => {
  const tsv = buildCommitFilesTsv([
    textFile("=HYPERLINK(\"https://example.test\")", 2, 1, "+old\tname"),
    { path: "assets/logo.png", additions: 999, deletions: 3, binary: true },
  ]);
  assert.match(tsv, /^path\toldpath\tadditions\tdeletions\tbinary\r\n/);
  assert.match(tsv, /'=HYPERLINK\(""https:\/\/example\.test""\)/);
  assert.match(tsv, /"'\+old\tname"\t2\t1\tfalse/);
  assert.match(tsv, /assets\/logo\.png\t\tunknown\tunknown\ttrue/);
  assert.ok(!tsv.includes("\t0\t0\ttrue"), "binary rows must not be represented as measured zero lines");
});

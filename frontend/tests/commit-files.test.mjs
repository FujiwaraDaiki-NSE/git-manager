import test from "node:test";
import assert from "node:assert/strict";
import {
  COMMIT_FILE_DIRECTORY_ROOT,
  COMMIT_FILE_EXTENSION_NONE,
  buildCommitFilesPathList,
  buildCommitFilesTsv,
  commitFileDirectory,
  commitFileChangeVolume,
  commitFileExtension,
  countCommitFileKinds,
  filterCommitFilesByDirectory,
  filterCommitFilesByExtension,
  filterCommitFiles,
  listCommitFileDirectories,
  listCommitFileExtensions,
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

test("directory and extension filters use displayed paths, expose root, and classify dotfiles explicitly", () => {
  const files = [
    textFile("README", 1, 0),
    textFile(".gitignore", 1, 0),
    textFile(".env.local", 2, 1),
    textFile("src/app.TS", 4, 2),
    textFile("src/lib/archive.tar.gz", 8, 3),
    textFile("src/new.ts", 5, 1, "legacy/old.js"),
  ];

  assert.equal(commitFileDirectory(files[0]), COMMIT_FILE_DIRECTORY_ROOT);
  assert.equal(commitFileDirectory(files[5]), "src");
  assert.equal(commitFileExtension(files[0]), null);
  assert.equal(commitFileExtension(files[1]), null);
  assert.equal(commitFileExtension(files[2]), ".local");
  assert.equal(commitFileExtension(files[3]), ".ts");
  assert.equal(commitFileExtension({ path: "trailing.", additions: 0, deletions: 0, binary: false }), null);
  assert.deepEqual(listCommitFileDirectories(files), [".", "legacy", "src", "src/lib"]);
  assert.deepEqual(listCommitFileExtensions(files), [COMMIT_FILE_EXTENSION_NONE, ".gz", ".js", ".local", ".ts"]);
  assert.deepEqual(filterCommitFilesByDirectory(files, ".").map((file) => file.path), ["README", ".gitignore", ".env.local"]);
  assert.deepEqual(filterCommitFilesByDirectory(files, "src").map((file) => file.path), ["src/app.TS", "src/new.ts"]);
  assert.deepEqual(filterCommitFilesByDirectory(files, "legacy").map((file) => file.path), ["src/new.ts"]);
  assert.deepEqual(filterCommitFilesByExtension(files, COMMIT_FILE_EXTENSION_NONE).map((file) => file.path), ["README", ".gitignore"]);
  assert.deepEqual(filterCommitFilesByExtension(files, ".TS").map((file) => file.path), ["src/app.TS", "src/new.ts"]);
  assert.deepEqual(filterCommitFilesByExtension(files, ".js").map((file) => file.path), ["src/new.ts"]);
  assert.equal(buildCommitFilesPathList([files[5], files[0]]), "src/new.ts\nREADME");
  assert.throws(() => filterCommitFilesByDirectory(files, ""), RangeError);
  assert.throws(() => filterCommitFilesByExtension(files, "ts"), RangeError);
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

test("additions and deletions sorting keeps unknown and binary values last in both directions", () => {
  const files = [
    { path: "z-binary.dat", additions: 999, deletions: 999, binary: true },
    textFile("low.ts", 1, 9),
    textFile("high.ts", 8, 2),
    { path: "unknown-add.txt", additions: "-", deletions: 3, binary: false },
    { path: "unknown-delete.txt", additions: 3, deletions: "-", binary: false },
  ];
  assert.deepEqual(sortCommitFiles(files, "additions", "asc").map((file) => file.path), [
    "low.ts", "unknown-delete.txt", "high.ts", "unknown-add.txt", "z-binary.dat",
  ]);
  assert.deepEqual(sortCommitFiles(files, "additions", "desc").map((file) => file.path), [
    "high.ts", "unknown-delete.txt", "low.ts", "z-binary.dat", "unknown-add.txt",
  ]);
  assert.deepEqual(sortCommitFiles(files, "deletions", "asc").map((file) => file.path), [
    "high.ts", "unknown-add.txt", "low.ts", "unknown-delete.txt", "z-binary.dat",
  ]);
  assert.deepEqual(sortCommitFiles(files, "deletions", "desc").map((file) => file.path), [
    "low.ts", "unknown-add.txt", "high.ts", "z-binary.dat", "unknown-delete.txt",
  ]);
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

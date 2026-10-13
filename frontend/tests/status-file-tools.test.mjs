import assert from "node:assert/strict";
import test from "node:test";
import {
  STATUS_FILE_DIRECTORY_ROOT,
  STATUS_FILE_EXTENSION_NONE,
  buildStatusDiffCommands,
  filterStatusFilesByDirectory,
  filterStatusFilesByExtension,
  listStatusFileDirectories,
  listStatusFileExtensions,
  searchStatusFiles,
  sortStatusFiles,
  statusFileDirectory,
  statusFileExtension,
  statusFilesCsv,
} from "../app/status-file-tools.mjs";

const entries = [
  { xy: ".M", path: "src/zeta.ts" },
  { xy: "M.", path: "README" },
  { xy: "??", path: ".gitignore" },
  { xy: "MM", path: "src/.env.local" },
  { xy: "UU", path: "src/conflict.js" },
  { xy: "M.", path: "docs/read me.md" },
];

test("directory options use exact parent directories and keep root explicit", () => {
  assert.equal(statusFileDirectory("README"), STATUS_FILE_DIRECTORY_ROOT);
  assert.deepEqual(listStatusFileDirectories(entries), [".", "docs", "src"]);
  assert.deepEqual(
    filterStatusFilesByDirectory(entries, STATUS_FILE_DIRECTORY_ROOT).map((entry) => entry.path),
    ["README", ".gitignore"],
  );
  assert.deepEqual(
    filterStatusFilesByDirectory(entries, "src").map((entry) => entry.path),
    ["src/zeta.ts", "src/.env.local", "src/conflict.js"],
  );
  assert.deepEqual(filterStatusFilesByDirectory(entries, "s").map((entry) => entry.path), []);
});

test("extension semantics distinguish extensionless files and dotfiles", () => {
  assert.equal(statusFileExtension("README"), null);
  assert.equal(statusFileExtension(".gitignore"), null);
  assert.equal(statusFileExtension(".env.local"), ".local");
  assert.equal(statusFileExtension("trailing."), null);
  assert.deepEqual(listStatusFileExtensions(entries), [STATUS_FILE_EXTENSION_NONE, ".js", ".local", ".md", ".ts"]);
  assert.deepEqual(
    filterStatusFilesByExtension(entries, STATUS_FILE_EXTENSION_NONE).map((entry) => entry.path),
    ["README", ".gitignore"],
  );
  assert.deepEqual(
    filterStatusFilesByExtension(entries, ".LOCAL").map((entry) => entry.path),
    ["src/.env.local"],
  );
});

test("search and path sorting preserve the source and support both directions", () => {
  assert.deepEqual(searchStatusFiles(entries, " READ ").map((entry) => entry.path), ["README", "docs/read me.md"]);
  assert.deepEqual(sortStatusFiles(entries, "asc").map((entry) => entry.path), [".gitignore", "docs/read me.md", "README", "src/.env.local", "src/conflict.js", "src/zeta.ts"]);
  assert.deepEqual(sortStatusFiles(entries, "desc").map((entry) => entry.path), ["src/zeta.ts", "src/conflict.js", "src/.env.local", "README", "docs/read me.md", ".gitignore"]);
  assert.deepEqual(entries.map((entry) => entry.path), ["src/zeta.ts", "README", ".gitignore", "src/.env.local", "src/conflict.js", "docs/read me.md"]);
});

test("CSV includes visible status and path columns and neutralizes formula prefixes", () => {
  const csv = statusFilesCsv([
    { xy: "M.", path: "=HYPERLINK(\"x\")" },
    { xy: ".M", path: "+danger\nname" },
  ]);
  assert.equal(csv, '\uFEFF"status","path"\r\n"M.","\'=HYPERLINK(""x"")"\r\n".M","\'+danger\nname"\r\n');
});

test("diff commands match staged and unstaged XY independently and exclude unsafe status rows", () => {
  const result = buildStatusDiffCommands("/tmp/it's repo", [
    { xy: "MM", path: "src/$() [glob].ts" },
    { xy: "M.", path: "staged only.txt" },
    { xy: ".D", path: "deleted.txt" },
    { xy: "??", path: "untracked $(touch nope).txt" },
    { xy: "UU", path: "conflict.txt" },
    { xy: "XY", path: "unknown.txt" },
    { xy: "M.", path: "quote'\nfile.txt" },
  ]);
  assert.equal(
    result.staged,
    "git -C '/tmp/it'\\''s repo' diff --cached -- ':(literal)src/$() [glob].ts' ':(literal)staged only.txt' ':(literal)quote'\\''\nfile.txt'",
  );
  assert.equal(
    result.unstaged,
    "git -C '/tmp/it'\\''s repo' diff -- ':(literal)src/$() [glob].ts' ':(literal)deleted.txt'",
  );
  assert.deepEqual(result.excluded.untracked.map((entry) => entry.path), ["untracked $(touch nope).txt"]);
  assert.deepEqual(result.excluded.conflicts.map((entry) => entry.path), ["conflict.txt"]);
  assert.deepEqual(result.excluded.unsupported.map((entry) => entry.path), ["unknown.txt"]);
});

test("diff commands are absent when no visible tracked change matches a side", () => {
  const result = buildStatusDiffCommands("/repo", [
    { xy: "??", path: "untracked.txt" },
    { xy: "UU", path: "conflict.txt" },
  ]);
  assert.equal(result.staged, null);
  assert.equal(result.unstaged, null);
});

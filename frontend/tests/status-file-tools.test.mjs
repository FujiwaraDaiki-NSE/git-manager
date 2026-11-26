import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  STATUS_FILE_DIRECTORY_ROOT,
  STATUS_FILE_EXTENSION_NONE,
  buildStatusDiffCommands,
  buildStatusStageCommands,
  buildStatusUnstageCommand,
  buildUntrackedDirectoryCommand,
  filterStatusFilesByDirectory,
  filterStatusFilesByExtension,
  listStatusFileDirectories,
  listStatusFileExtensions,
  searchStatusFiles,
  sortStatusFiles,
  statusFileDirectory,
  statusFileExtension,
  statusFilesCsv,
  statusStagePaths,
} from "../app/status-file-tools.mjs";

const entries = [
  { xy: ".M", path: "src/zeta.ts" },
  { xy: "M.", path: "README" },
  { xy: "??", path: ".gitignore" },
  { xy: "MM", path: "src/.env.local" },
  { xy: "UU", path: "src/conflict.js" },
  { xy: "M.", path: "docs/read me.md" },
].map((entry) => ({ ...entry, original_path: null }));

test("untracked directory command lists only unignored files under the literal directory", (t) => {
  const repo = mkdtempSync(join(tmpdir(), "status other '"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  for (const directory of ["dir[1]", "dir1"]) {
    mkdirSync(join(repo, directory));
    writeFileSync(join(repo, directory, "visible.txt"), "");
    writeFileSync(join(repo, directory, "ignored.log"), "");
  }
  writeFileSync(join(repo, ".gitignore"), "*.log\n");
  const buildCommand = (xy, path) => buildUntrackedDirectoryCommand(repo, { xy, path, original_path: null });
  assert.equal(execSync(buildCommand("??", "dir[1]/"), { encoding: "utf8" }), "dir[1]/visible.txt\n");
  assert.equal(buildCommand("??", ".gitignore"), null);
  assert.equal(buildCommand(".M", "dir[1]/"), null);
});

test("unstage command restores only the selected regular file's index and keeps worktree edits", (t) => {
  const repo = mkdtempSync(join(tmpdir(), "status unstage '"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  const path = "literal[ab].txt";
  git("init", "-q");
  for (const name of [path, "literala.txt"]) writeFileSync(join(repo, name), "base\n");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base");
  for (const name of [path, "literala.txt"]) writeFileSync(join(repo, name), "staged\n");
  git("add", ".");
  writeFileSync(join(repo, path), "worktree\n");

  const selected = { xy: "MM", path, original_path: null, regular_file: true };
  assert.equal(buildStatusUnstageCommand(repo, false, [selected], [selected]), null);
  const excluded = [
    { ...selected, xy: ".M", path: "unstaged" },
    { ...selected, xy: "UU", path: "conflict" },
    { ...selected, xy: "R.", path: "rename", original_path: "old" },
    { ...selected, xy: "C.", path: "copy", original_path: "old" },
    { ...selected, path: "submodule", regular_file: false },
    { ...selected, path: "unknown type", regular_file: undefined },
  ];
  const all = [selected, ...excluded];
  assert.equal(buildStatusUnstageCommand(repo, true, excluded, all), null);
  execSync(buildStatusUnstageCommand(repo, true, all, all));
  assert.equal(git("diff", "--cached", "--name-only"), "literala.txt\n");
  assert.equal(git("show", `:${path}`), "base\n");
  assert.equal(readFileSync(join(repo, path), "utf8"), "worktree\n");
});

test("unstage excludes both sides of a file/directory collision in the full status list", () => {
  const parent = { xy: "D.", path: "foo", original_path: null, regular_file: true };
  const child = { ...parent, xy: "A.", path: "foo/bar" };
  const unrelated = { ...child, path: "foobar" };
  const all = [parent, child, unrelated];

  assert.equal(buildStatusUnstageCommand("/repo", true, [parent], all), null);
  assert.equal(buildStatusUnstageCommand("/repo", true, [child], all), null);
  assert.equal(buildStatusUnstageCommand("/repo", true, all, all), "git -C '/repo' restore --staged -- ':(literal)foobar'");
});

test("stage commands target exactly the selected literal paths", (t) => {
  const repo = mkdtempSync(join(tmpdir(), "status stage '"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "-q");
  for (const path of ["space 'file", "literal[ab].txt", "literala.txt"]) writeFileSync(join(repo, path), "test\n");
  const selected = ["space 'file", "literal[ab].txt"].map((path) => ({ xy: "??", path, original_path: null }));
  const commands = buildStatusStageCommands(repo, selected);
  const dryRun = execSync(commands.dryRun, { encoding: "utf8" });
  assert.match(dryRun, /literal\[ab\]\.txt/);
  assert.match(dryRun, /space 'file/);
  assert.doesNotMatch(dryRun, /literala\.txt/);
  assert.equal(git("diff", "--cached", "--name-only"), "");
  execSync(commands.add);
  assert.deepEqual(git("diff", "--cached", "--name-only", "-z").split("\0"), ["literal[ab].txt", "space 'file", ""]);
});

test("only a worktree rename with both paths adds its source to the stage command", () => {
  const unsupported = [
    { xy: ".R", path: "unknown", original_path: null },
    { xy: "UU", path: "conflict", original_path: null },
    { xy: "R.", path: "already staged", original_path: "previous" },
    { xy: "??", path: "directory/", original_path: null },
  ];
  assert.equal(buildStatusStageCommands("/repo", unsupported), null);
  const commands = buildStatusStageCommands("/repo", [
    ...unsupported,
    { xy: ".R", path: "new", original_path: "old" },
    { xy: ".C", path: "copy", original_path: "other" },
    { xy: "RM", path: "edited after rename", original_path: "previous name" },
  ]);
  assert.equal(commands.add, "git -C '/repo' add -- ':(literal)old' ':(literal)new' ':(literal)copy' ':(literal)edited after rename'");
});

test("stage paths exclude rows with a replacement character in either path", () => {
  assert.deepEqual(statusStagePaths({ xy: "??", path: "new\uFFFD.txt", original_path: null }), []);
  assert.deepEqual(statusStagePaths({ xy: ".R", path: "new.txt", original_path: "old\uFFFD.txt" }), []);
});

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


test("a directory named all does not collide with the all-directories option", () => {
  const rows = [{xy: ".M", path: "all/file.ts"}, {xy: ".M", path: "other/file.ts"}];
  assert.deepEqual(filterStatusFilesByDirectory(rows, "all"), [rows[0]]);
  assert.deepEqual(filterStatusFilesByDirectory(rows, "/"), rows);
});

test("rename/copy without original paths remain excluded", () => {
  const rows = [{xy: "R.", path: "renamed.ts", original_path: null}, {xy: ".R", path: "other.ts", original_path: null}, {xy: "C.", path: "copied.ts", original_path: null}];
  const result = buildStatusDiffCommands("/repo", rows);
  assert.equal(result.staged, null);
  assert.equal(result.unstaged, null);
  assert.deepEqual(result.excluded.unsupported, rows);
});

test("rename and copy search matches original and destination without changing exports", () => {
  for (const xy of ["R.", "C."]) {
    const entry = { xy, path: "new/destination.txt", original_path: "old/元の名前.txt" };
    assert.deepEqual(searchStatusFiles([entry], "OLD/元"), [entry]);
    assert.deepEqual(searchStatusFiles([entry], "DESTINATION"), [entry]);
    assert.deepEqual(searchStatusFiles([entry], "missing"), []);
    assert.equal(statusFilesCsv([entry]), statusFilesCsv([{ ...entry, original_path: null }]));
  }
});

test("rename/copy commands use literal source and destination on the reported side", () => {
  for (const code of ["R", "C"]) {
    for (const xy of [`${code}.`, `${code}M`, `.${code}`]) {
      const result = buildStatusDiffCommands("/repo", [{ xy, original_path: "旧 名前[1].txt", path: "新 名前*.txt" }]);
      const paths = "':(literal)旧 名前[1].txt' ':(literal)新 名前*.txt'";
      assert.equal(result.staged, xy[0] === code ? `git -C '/repo' diff --cached -- ${paths}` : null);
      assert.equal(result.unstaged, xy[1] === code ? `git -C '/repo' diff -- ${paths}` : xy[1] === "M" ? "git -C '/repo' diff -- ':(literal)新 名前*.txt'" : null);
      assert.deepEqual(result.excluded.unsupported, []);
    }
  }
});

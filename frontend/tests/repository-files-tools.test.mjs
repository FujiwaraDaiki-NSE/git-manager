import test from "node:test";
import assert from "node:assert/strict";
import {
  REPOSITORY_FILES_MAX_PREVIEW_BYTES,
  boundedRepositoryText,
  buildRepositoryFileHistoryHref,
  buildRepositoryGitHubRangeHref,
  filterRepositoryFileEntries,
  findRepositorySymlinkTarget,
  listRepositoryDirectoryEntries,
  repositoryBase64ToBytes,
  repositoryFileLineContext,
  repositoryFilesQuery,
  repositoryFileQuery,
  repositoryImagePreviewSrc,
  searchRepositoryFileEntries,
} from "../app/repository-files-tools.mjs";

const entries = [
  { path: "README.md", mode: "100644", type: "blob", hash: "a".repeat(40) },
  { path: "src", mode: "040000", type: "tree", hash: "b".repeat(40) },
  { path: "src/example.ts", mode: "100644", type: "blob", hash: "c".repeat(40) },
  { path: "src/deep", mode: "040000", type: "tree", hash: "d".repeat(40) },
  { path: "src/deep/value.ts", mode: "100644", type: "blob", hash: "e".repeat(40) },
];

test("repository API helpers keep all required filters explicit", () => {
  assert.equal(repositoryFilesQuery("/repo", "HEAD", "", ""), "path=%2Frepo&revision=HEAD&directory=&query=");
  assert.equal(repositoryFileQuery("/repo", "abc", "src/a [x].ts"), "path=%2Frepo&revision=abc&file=src%2Fa+%5Bx%5D.ts");
  assert.throws(() => repositoryFilesQuery("/repo", "HEAD", ""), /query/);
  assert.throws(() => repositoryFileQuery("/repo", "HEAD"), /file/);
});

test("blame excerpts keep Git line numbers and five surrounding lines", () => {
  const text = Array.from({ length: 20 }, (_, index) => `row ${index + 1}`).join("\n");
  const excerpt = repositoryFileLineContext(text, false, 8);
  assert.deepEqual(excerpt.map(({ number }) => number), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.deepEqual(excerpt[5], { number: 8, content: "row 8" });
  assert.deepEqual(repositoryFileLineContext("\tfirst\r\n\nlast", false, 1), [
    { number: 1, content: "\tfirst\r" }, { number: 2, content: "" }, { number: 3, content: "last" },
  ]);
});

test("blame excerpts omit an incomplete final line and never invent a line after LF", () => {
  assert.deepEqual(repositoryFileLineContext("first\npartial", true, 1), [{ number: 1, content: "first" }]);
  assert.equal(repositoryFileLineContext("first\npartial", true, 2), null);
  assert.equal(repositoryFileLineContext("first\n", false, 2), null);
  assert.equal(repositoryFileLineContext("first\n", true, 3), null);
});

test("symlink targets resolve to the exact file or directory in the retrieved tree", () => {
  assert.equal(findRepositorySymlinkTarget(entries, "src/deep/link", "../.././README.md"), entries[0]);
  assert.equal(findRepositorySymlinkTarget(entries, "src/link", "./deep/"), entries[3]);
  assert.equal(findRepositorySymlinkTarget(entries, "link", "src//deep/value.ts"), entries[4]);
});

test("symlink targets stay unavailable when the retrieved tree cannot confirm them", () => {
  for (const target of ["/README.md", "C:\\README.md", "../../README.md", "missing", "gone/../example.ts", "example.ts/", "example.ts "]) {
    assert.equal(findRepositorySymlinkTarget(entries, "src/link", target), null, target);
  }
});

test("directory browsing creates only immediate children and breadcrumbs stay local", () => {
  assert.deepEqual(listRepositoryDirectoryEntries(entries, "").map((entry) => [entry.path, entry.type]), [["README.md", "blob"], ["src", "tree"]]);
  assert.deepEqual(listRepositoryDirectoryEntries(entries, "src").map((entry) => [entry.path, entry.type]), [["src/deep", "tree"], ["src/example.ts", "blob"]]);
  assert.deepEqual(filterRepositoryFileEntries(entries, "src", "").map((entry) => entry.path), ["src/deep", "src/example.ts"]);
});

test("path search covers all retrieved file entries and excludes directories", () => {
  assert.deepEqual(searchRepositoryFileEntries(entries, "EXAMPLE ts").map((entry) => entry.path), ["src/example.ts"]);
  assert.deepEqual(searchRepositoryFileEntries(entries, "src" ).map((entry) => entry.path), ["src/deep/value.ts", "src/example.ts"]);
});

test("history handoff pins full hash, exact file, explicit follow, and info tab", () => {
  const hash = "a".repeat(40);
  const href = buildRepositoryFileHistoryHref("/project?path=%2Fold&tab=files&investigation=compare&investigationBase=x&investigationTarget=y&investigationMode=direct", "/repo", hash, "src/example.ts", true);
  const url = new URL(href, "http://localhost");
  assert.equal(url.searchParams.get("path"), "/repo");
  assert.equal(url.searchParams.get("tab"), "info");
  assert.equal(url.searchParams.get("investigation"), "file-history");
  assert.equal(url.searchParams.get("investigationRevision"), hash);
  assert.equal(url.searchParams.get("investigationFile"), "src/example.ts");
  assert.equal(url.searchParams.get("investigationFollow"), "true");
  assert.equal(url.searchParams.get("investigationBase"), null);
  assert.throws(() => buildRepositoryFileHistoryHref("/project", "/repo", "HEAD", "a", true), /full resolved hash/);
  assert.throws(() => buildRepositoryFileHistoryHref("/project", "/repo", hash, "a"), /follow/);
});

test("binary base64 decoding preserves every byte and text previews are bounded", () => {
  assert.deepEqual(Array.from(repositoryBase64ToBytes("AAH/")), [0, 1, 255]);
  const text = "あ".repeat(REPOSITORY_FILES_MAX_PREVIEW_BYTES);
  const bounded = boundedRepositoryText(text);
  assert.ok(new TextEncoder().encode(bounded).byteLength <= REPOSITORY_FILES_MAX_PREVIEW_BYTES);
  assert.throws(() => repositoryBase64ToBytes("not base64!"), /base64/);
});

test("image previews require complete PNG or JPEG bytes regardless of file name", () => {
  const png = { kind: "blob", path: "image.bin", truncated: false, size: 8, content_base64: "iVBORw0KGgo=" };
  const jpeg = { ...png, size: 4, content_base64: "/9j/4A==" };
  assert.equal(repositoryImagePreviewSrc(png), "data:image/png;base64,iVBORw0KGgo=");
  assert.equal(repositoryImagePreviewSrc(jpeg), "data:image/jpeg;base64,/9j/4A==");
  assert.equal(repositoryImagePreviewSrc({ ...png, truncated: true }), null);
  assert.equal(repositoryImagePreviewSrc({ ...jpeg, size: 5 }), null);
  assert.equal(repositoryImagePreviewSrc({ ...png, size: 3, path: "unknown.png", content_base64: "AAH/" }), null);
  assert.equal(repositoryImagePreviewSrc({ ...png, content_base64: "invalid!" }), null);
});

test("GitHub range links encode the file path and keep the full commit and selected lines", () => {
  const sha = "a".repeat(40);
  const file = "src/日本語 #%.ts";
  const range = { start: 2, end: 4 };
  const expected = `https://github.com/owner/repo/blob/${sha}/src/%E6%97%A5%E6%9C%AC%E8%AA%9E%20%23%25.ts#L2-L4`;
  for (const remote of ["https://github.com/owner/repo", "git@github.com:owner/repo.git", "ssh://git@github.com/owner/repo.git"]) {
    assert.equal(buildRepositoryGitHubRangeHref(remote, sha, file, range), expected);
  }
  const remote = "https://github.com/owner/repo";
  assert.equal(buildRepositoryGitHubRangeHref(null, sha, file, range), null);
  assert.equal(buildRepositoryGitHubRangeHref("https://github.com.example/owner/repo", sha, file, range), null);
  assert.equal(buildRepositoryGitHubRangeHref(remote, sha.slice(0, 12), file, range), null);
  assert.equal(buildRepositoryGitHubRangeHref(remote, sha, "", range), null);
  assert.equal(buildRepositoryGitHubRangeHref(remote, sha, file, null), null);
  assert.equal(buildRepositoryGitHubRangeHref(remote, sha, file, { start: 4, end: 2 }), null);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  REPOSITORY_FILES_MAX_PREVIEW_BYTES,
  boundedRepositoryText,
  buildRepositoryFileHistoryHref,
  filterRepositoryFileEntries,
  listRepositoryDirectoryEntries,
  repositoryBase64ToBytes,
  repositoryFilesQuery,
  repositoryFileQuery,
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

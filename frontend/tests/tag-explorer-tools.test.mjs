import test from "node:test";
import assert from "node:assert/strict";
import {
  tagCreatorIdentity,
  filterTags,
  searchTags,
  sortTags,
  tagsCsv,
  visibleTags,
} from "../app/tag-explorer-tools.mjs";

const tags = [
  { name: "v2.0", type: "annotated", hash: "tag-hash", peeled_hash: "commit-2", peeled_type: "commit", creator: "Release", creator_date: "2026-02-02T00:00:00+00:00" },
  { name: "v1.0", type: "lightweight", hash: "commit-1", peeled_hash: "commit-1", peeled_type: "commit", creator: "Older", creator_date: "2026-01-01T00:00:00+00:00" },
  { name: "odd", type: "annotated", hash: "tag-odd", peeled_hash: "tree-1", peeled_type: "tree", creator: null, creator_date: null },
];

test("tag search is an exact name match and does not broaden a typo", () => {
  assert.deepEqual(searchTags(tags, "v2.0"), [tags[0]]);
  assert.deepEqual(searchTags(tags, "v2"), []);
  assert.deepEqual(searchTags(tags, ""), tags);
});

test("type filter keeps lightweight and annotated facts explicit", () => {
  assert.deepEqual(filterTags(tags, "lightweight").map((tag) => tag.name), ["v1.0"]);
  assert.deepEqual(filterTags(tags, "annotated").map((tag) => tag.name), ["v2.0", "odd"]);
  assert.deepEqual(filterTags(tags, "invalid"), []);
});

test("name and creator-date sorting preserve unknown dates at the end", () => {
  assert.deepEqual(sortTags(tags, "name").map((tag) => tag.name), ["odd", "v1.0", "v2.0"]);
  assert.deepEqual(sortTags(tags, "oldest").map((tag) => tag.name), ["v1.0", "v2.0", "odd"]);
  assert.deepEqual(sortTags(tags, "newest").map((tag) => tag.name), ["v2.0", "v1.0", "odd"]);
  assert.notStrictEqual(sortTags(tags, "name"), tags);
});

test("visible tags compose exact search, type and sort", () => {
  assert.deepEqual(visibleTags(tags, { query: "v2.0", type: "annotated", sort: "newest" }).map((tag) => tag.name), ["v2.0"]);
  assert.deepEqual(visibleTags(tags, { query: "v2", type: "all", sort: "name" }), []);
});

test("tag CSV quotes cells and neutralizes spreadsheet formulas", () => {
  const csv = tagsCsv([{ ...tags[0], name: "=LOOKUP(A1)", creator: "A, B\nC" }, tags[2]]);
  assert.match(csv, /^\uFEFF"name","type","hash"/u);
  assert.match(csv, /"'=LOOKUP\(A1\)"/u);
  assert.match(csv, /"A, B\nC"/u);
  assert.match(csv, /"odd","annotated","tag-odd","tree-1","tree","",""/u);
});


test("creator display separates Git's epoch/timezone suffix without altering an identity", () => {
  assert.equal(tagCreatorIdentity("Release 2026 <release@example.test> 1792191825 +0900"), "Release 2026 <release@example.test>");
  assert.equal(tagCreatorIdentity("Before epoch <before@example.test> -1 -0500"), "Before epoch <before@example.test>");
  assert.equal(tagCreatorIdentity("Release 2026"), "Release 2026");
  assert.equal(tagCreatorIdentity(null), null);
});

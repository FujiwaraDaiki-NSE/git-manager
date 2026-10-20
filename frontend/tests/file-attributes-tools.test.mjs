import assert from "node:assert/strict";
import test from "node:test";
import {
  EOL_FILTER_ANOMALOUS,
  EOL_FILTER_MIXED,
  EOL_FILTER_UNKNOWN,
  FILE_ATTRIBUTES_DIRECTORY_ROOT,
  attributeComparison,
  compareFileAttributes,
  fileAttributesCsv,
  fileAttributesDirectory,
  filterFileAttributeEntries,
  listFileAttributeDirectories,
  searchFileAttributeEntries,
  sortFileAttributeEntries,
} from "../app/file-attributes-tools.mjs";

const entries = [
  { path: "src/crlf.txt", index_eol: "lf", worktree_eol: "crlf", attribute_eol: "lf", flags: ["different"], eol_status: "different" },
  { path: "src/mixed.txt", index_eol: "lf", worktree_eol: "mixed", attribute_eol: "lf", flags: ["mixed", "different"], eol_status: "mixed" },
  { path: "binary.bin", index_eol: "-text", worktree_eol: "-text", attribute_eol: null, flags: [], eol_status: "same" },
  { path: "unknown\nfile", index_eol: "?", worktree_eol: "?", attribute_eol: null, flags: ["unknown"], eol_status: "unknown" },
];

test("directory and search helpers preserve root, whitespace, and newline paths", () => {
  assert.equal(fileAttributesDirectory("README"), FILE_ATTRIBUTES_DIRECTORY_ROOT);
  assert.deepEqual(listFileAttributeDirectories(entries), [".", "src"]);
  assert.deepEqual(searchFileAttributeEntries(entries, " MIXED ").map((entry) => entry.path), ["src/mixed.txt"]);
  assert.deepEqual(sortFileAttributeEntries(entries, "asc").map((entry) => entry.path), ["binary.bin", "src/crlf.txt", "src/mixed.txt", "unknown\nfile"]);
});

test("EOL filters use only explicit backend flags", () => {
  assert.deepEqual(
    filterFileAttributeEntries(entries, { query: "", directory: "/", eol: EOL_FILTER_ANOMALOUS }).map((entry) => entry.path),
    ["src/crlf.txt", "src/mixed.txt"],
  );
  assert.deepEqual(
    filterFileAttributeEntries(entries, { query: "", directory: "/", eol: EOL_FILTER_MIXED }).map((entry) => entry.path),
    ["src/mixed.txt"],
  );
  assert.deepEqual(
    filterFileAttributeEntries(entries, { query: "", directory: "/", eol: EOL_FILTER_UNKNOWN }).map((entry) => entry.path),
    ["unknown\nfile"],
  );
});

test("attribute comparison preserves absent values separately from returned unspecified", () => {
  const result = compareFileAttributes(
    { path: "left", attributes: { text: "set", custom: "unspecified" } },
    { path: "right", attributes: { eol: "lf" } },
  );
  assert.deepEqual(result, attributeComparison(
    { path: "left", attributes: { text: "set", custom: "unspecified" } },
    { path: "right", attributes: { eol: "lf" } },
  ));
  const text = result.rows.find((row) => row.name === "text");
  const custom = result.rows.find((row) => row.name === "custom");
  assert.deepEqual(text, { name: "text", left: "set", right: null, leftPresent: true, rightPresent: false, same: false });
  assert.deepEqual(custom, { name: "custom", left: "unspecified", right: null, leftPresent: true, rightPresent: false, same: false });
  assert.equal(result.identical, false);
});

test("CSV includes current EOL facts and protects formula-like paths and values", () => {
  const csv = fileAttributesCsv(
    [{ ...entries[0], path: "=HYPERLINK(\"x\")" }, entries[1]],
    [{ path: "=HYPERLINK(\"x\")", attributes: { custom: "+danger" } }],
    "index",
  );
  assert.equal(csv, '\uFEFF"path","index_eol","worktree_eol","attribute_eol","eol_status","attributes","attribute_mode","attribute:custom"\r\n"\'=HYPERLINK(""x"")","lf","crlf","lf","different","custom=+danger","index","\'+danger"\r\n"src/mixed.txt","lf","mixed","lf","mixed","","index",""\r\n');
});

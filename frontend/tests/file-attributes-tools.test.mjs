import assert from "node:assert/strict";
import test from "node:test";
import {
  EOL_FILTER_ANOMALOUS,
  EOL_FILTER_MIXED,
  EOL_FILTER_UNKNOWN,
  FILE_ATTRIBUTES_DIRECTORY_ROOT,
  FILE_ATTRIBUTES_EXTENSION_ALL,
  FILE_ATTRIBUTES_EOL_VALUE_ALL,
  attributeComparison,
  compareFileAttributes,
  fileAttributesCsv,
  fileAttributesDirectory,
  fileAttributesExtension,
  fileAttributesJson,
  fileAttributePathsJsonl,
  filterFileAttributeEntries,
  listFileAttributeDirectories,
  listFileAttributeExtensions,
  listFileAttributeEolValues,
  searchFileAttributeEntries,
  sortFileAttributeEntries,
  selectDisplayedFileAttributePaths,
} from "../app/file-attributes-tools.mjs";

const entries = [
  { path: "src/crlf.txt", index_eol: "lf", worktree_eol: "crlf", attribute_eol: "lf", flags: ["different"], eol_status: "different" },
  { path: "src/mixed.txt", index_eol: "lf", worktree_eol: "mixed", attribute_eol: "lf", flags: ["mixed", "different"], eol_status: "mixed" },
  { path: "binary.bin", index_eol: "-text", worktree_eol: "-text", attribute_eol: null, flags: [], eol_status: "same" },
  { path: "unknown\nfile", index_eol: "?", worktree_eol: "?", attribute_eol: null, flags: ["unknown"], eol_status: "unknown" },
];

const allFilters = {
  query: "",
  directory: "/",
  eol: "all",
  extension: FILE_ATTRIBUTES_EXTENSION_ALL,
  indexEol: FILE_ATTRIBUTES_EOL_VALUE_ALL,
  worktreeEol: FILE_ATTRIBUTES_EOL_VALUE_ALL,
  selectedPaths: [],
  selectedOnly: false,
};

test("directory and search helpers preserve root, whitespace, and newline paths", () => {
  assert.equal(fileAttributesDirectory("README"), FILE_ATTRIBUTES_DIRECTORY_ROOT);
  assert.deepEqual(listFileAttributeDirectories(entries), [".", "src"]);
  assert.deepEqual(searchFileAttributeEntries(entries, " MIXED ").map((entry) => entry.path), ["src/mixed.txt"]);
  assert.deepEqual(sortFileAttributeEntries(entries, "asc").map((entry) => entry.path), ["binary.bin", "src/crlf.txt", "src/mixed.txt", "unknown\nfile"]);
});

test("EOL filters use only explicit backend flags", () => {
  assert.deepEqual(
    filterFileAttributeEntries(entries, { ...allFilters, eol: EOL_FILTER_ANOMALOUS }).map((entry) => entry.path),
    ["src/crlf.txt", "src/mixed.txt"],
  );
  assert.deepEqual(
    filterFileAttributeEntries(entries, { ...allFilters, eol: EOL_FILTER_MIXED }).map((entry) => entry.path),
    ["src/mixed.txt"],
  );
  assert.deepEqual(
    filterFileAttributeEntries(entries, { ...allFilters, eol: EOL_FILTER_UNKNOWN }).map((entry) => entry.path),
    ["unknown\nfile"],
  );
});

test("extension filtering is exact, including extensionless names and dotfiles", () => {
  const paths = ["README", ".env", "dir.with.dot/Makefile", "src/app.ts", "src/app.TS", "src/settings.local.json", "src/file."];
  const files = paths.map((path) => ({ ...entries[0], path }));
  assert.equal(fileAttributesExtension(".env"), "");
  assert.equal(fileAttributesExtension("src/settings.local.json"), ".json");
  assert.deepEqual(listFileAttributeExtensions(files), ["", ".", ".TS", ".json", ".ts"]);
  assert.deepEqual(filterFileAttributeEntries(files, { ...allFilters, extension: "" }).map((entry) => entry.path), paths.slice(0, 3));
  assert.deepEqual(filterFileAttributeEntries(files, { ...allFilters, extension: ".ts" }).map((entry) => entry.path), ["src/app.ts"]);
  assert.equal(filterFileAttributeEntries(files, allFilters).length, files.length);
});

test("index and worktree EOL selectors use exact independent Git values", () => {
  assert.deepEqual(listFileAttributeEolValues(entries, "index_eol"), ["-text", "?", "lf"]);
  assert.deepEqual(listFileAttributeEolValues(entries, "worktree_eol"), ["-text", "?", "crlf", "mixed"]);
  assert.deepEqual(filterFileAttributeEntries(entries, { ...allFilters, indexEol: "lf" }).map((entry) => entry.path), ["src/crlf.txt", "src/mixed.txt"]);
  assert.deepEqual(filterFileAttributeEntries(entries, { ...allFilters, worktreeEol: "crlf" }).map((entry) => entry.path), ["src/crlf.txt"]);
  assert.deepEqual(filterFileAttributeEntries(entries, { ...allFilters, indexEol: "crlf", worktreeEol: "crlf" }), []);
  assert.deepEqual(filterFileAttributeEntries(entries, { ...allFilters, directory: "src", extension: ".txt", indexEol: "lf", worktreeEol: "mixed", eol: "mixed" }).map((entry) => entry.path), ["src/mixed.txt"]);
  assert.throws(() => listFileAttributeEolValues(entries, "attribute_eol"), /Unknown EOL field/);
  assert.throws(() => filterFileAttributeEntries(entries, { ...allFilters, indexEol: undefined }), /indexEol must be provided explicitly/);
});

test("bulk selection adds displayed paths in order and caps total selections at 100", () => {
  const displayed = Array.from({ length: 105 }, (_, index) => ({ path: `visible/${index}` }));
  const current = ["previously-selected-hidden", "visible/1"];
  const result = selectDisplayedFileAttributePaths(displayed, current);
  assert.equal(result.length, 100);
  assert.deepEqual(result.slice(0, 4), ["previously-selected-hidden", "visible/1", "visible/0", "visible/2"]);
  assert.equal(result.at(-1), "visible/98");
  assert.equal(result.includes("visible/99"), false);
  assert.deepEqual(current, ["previously-selected-hidden", "visible/1"]);
  assert.deepEqual(selectDisplayedFileAttributePaths([{ path: "only-displayed" }], []), ["only-displayed"]);
  assert.deepEqual(selectDisplayedFileAttributePaths([{ path: "not-added-at-cap" }], result), result);
  assert.throws(() => selectDisplayedFileAttributePaths(displayed, displayed.slice(0, 101).map((entry) => entry.path)), /too many selected paths/);
});

test("selected-only view intersects selection with every active filter and supports cleared selection", () => {
  const selected = ["src/crlf.txt", "binary.bin", "not-in-inventory"];
  assert.deepEqual(filterFileAttributeEntries(entries, { ...allFilters, selectedOnly: true, selectedPaths: selected }).map((entry) => entry.path), ["src/crlf.txt", "binary.bin"]);
  assert.deepEqual(filterFileAttributeEntries(entries, { ...allFilters, selectedOnly: true, selectedPaths: selected, directory: "src" }).map((entry) => entry.path), ["src/crlf.txt"]);
  assert.deepEqual(filterFileAttributeEntries(entries, { ...allFilters, selectedOnly: true }), []);
  assert.throws(() => filterFileAttributeEntries(entries, { ...allFilters, selectedOnly: undefined }), /selectedOnly must be provided explicitly/);
});

test("JSON export carries bounded inventory coverage and actual evaluation context for displayed rows", () => {
  const inventory = { entries, truncated: true, limit: 5000, byte_limit: 5242880, command: "git ls-files --eol -z" };
  const attributeResult = {
    mode: "index", paths: ["src/crlf.txt", "binary.bin"], limit: 100, byte_limit: 5242880,
    command: "git check-attr --cached --all --stdin",
    entries: [{ path: "src/crlf.txt", attributes: { eol: "lf", custom: "unspecified" } }, { path: "binary.bin", attributes: {} }],
  };
  const filters = { ...allFilters, extension: ".txt", selectedOnly: true, order: "desc" };
  delete filters.selectedPaths;
  const json = JSON.parse(fileAttributesJson([entries[0]], { repositoryPath: "/repos/example", inventory, filters, selectedPaths: ["src/crlf.txt", "binary.bin"], attributeResult }));
  assert.equal(json.repository_path, "/repos/example");
  assert.deepEqual(json.inventory, { returned_count: 4, truncated: true, limit: 5000, byte_limit: 5242880, command: "git ls-files --eol -z" });
  assert.deepEqual(json.entries, [entries[0]]);
  assert.equal(json.displayed_count, 1);
  assert.deepEqual(json.filters, filters);
  assert.deepEqual(json.selected_paths, ["src/crlf.txt", "binary.bin"]);
  assert.deepEqual(json.attribute_evaluation, {
    mode: "index", requested_paths: attributeResult.paths, returned_count: 2, limit: 100, byte_limit: 5242880,
    command: "git check-attr --cached --all --stdin", entries: [attributeResult.entries[0]],
  });
  const uninspected = JSON.parse(fileAttributesJson([entries[0]], { repositoryPath: "/repos/example", inventory, filters, selectedPaths: [], attributeResult: null }));
  assert.equal(uninspected.attribute_evaluation, null);
  assert.throws(() => fileAttributesJson([], { repositoryPath: "/repos/example", inventory, filters, selectedPaths: [] }), TypeError);
});

test("displayed path JSONL round-trips unusual path characters with one record per line", () => {
  const paths = [" leading and trailing ", "line\nbreak.txt", "tab\tfile", 'a"quote', "slash\\file", "日本語.txt"];
  const jsonl = fileAttributePathsJsonl(paths.map((path) => ({ path })));
  assert.equal(jsonl.split("\n").length, paths.length);
  assert.deepEqual(jsonl.split("\n").map((line) => JSON.parse(line)), paths);
  assert.equal(fileAttributePathsJsonl([]), "");
  assert.throws(() => fileAttributePathsJsonl([{ path: null }]), /explicit paths/);
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

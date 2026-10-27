/**
 * Pure helpers for the tracked-file EOL and Git-attribute investigation.
 *
 * The API publishes facts from ``git ls-files --eol`` and
 * ``git check-attr --all``.  These helpers keep missing attribute keys
 * missing, so a comparison never turns an absent successful result into an
 * inferred value from the other path or mode.
 */

export const FILE_ATTRIBUTES_DIRECTORY_ALL = "/";
export const FILE_ATTRIBUTES_DIRECTORY_ROOT = ".";
export const FILE_ATTRIBUTES_EXTENSION_ALL = "/";
export const FILE_ATTRIBUTES_EOL_VALUE_ALL = "/";
export const EOL_FILTER_ALL = "all";
export const EOL_FILTER_ANOMALOUS = "anomalous";
export const EOL_FILTER_DIFFERENT = "different";
export const EOL_FILTER_MIXED = "mixed";
export const EOL_FILTER_UNKNOWN = "unknown";
export const EOL_FILTERS = [
  { key: EOL_FILTER_ALL, label: "すべて" },
  { key: EOL_FILTER_ANOMALOUS, label: "差異あり" },
  { key: EOL_FILTER_MIXED, label: "混在" },
  { key: EOL_FILTER_UNKNOWN, label: "不明" },
];
export const FILE_ATTRIBUTE_MODES = ["worktree", "index"];
export const FILE_ATTRIBUTES_MAX_ATTRIBUTE_PATHS = 100;

function requireString(value, name) {
  if (typeof value !== "string") throw new TypeError(`${name} must be provided explicitly`);
  return value;
}

function requireEntries(entries) {
  if (!Array.isArray(entries)) throw new TypeError("entries must be provided explicitly");
  return entries;
}

function requirePaths(paths) {
  if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string" && path.length > 0)) {
    throw new TypeError("selected paths must be provided explicitly");
  }
  return paths;
}

function entryPath(entry) {
  if (!entry || typeof entry.path !== "string" || entry.path.length === 0) return null;
  return entry.path;
}

function comparePaths(left, right) {
  const a = entryPath(left) || "";
  const b = entryPath(right) || "";
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

export function fileAttributesDirectory(path) {
  requireString(path, "path");
  const separator = path.lastIndexOf("/");
  return separator < 0 ? FILE_ATTRIBUTES_DIRECTORY_ROOT : path.slice(0, separator);
}

export function listFileAttributeDirectories(entries) {
  requireEntries(entries);
  const directories = new Set();
  for (const entry of entries) {
    const path = entryPath(entry);
    if (path) directories.add(fileAttributesDirectory(path));
  }
  return [...directories].sort((left, right) => {
    if (left === FILE_ATTRIBUTES_DIRECTORY_ROOT) return -1;
    if (right === FILE_ATTRIBUTES_DIRECTORY_ROOT) return 1;
    return left.localeCompare(right, undefined, { sensitivity: "base" });
  });
}

/** Extension spelling is exact; dotfiles without another dot are extensionless. */
export function fileAttributesExtension(path) {
  requireString(path, "path");
  const filename = path.slice(path.lastIndexOf("/") + 1);
  const dot = filename.lastIndexOf(".");
  return dot <= 0 ? "" : filename.slice(dot);
}

export function listFileAttributeExtensions(entries) {
  requireEntries(entries);
  return [...new Set(entries.map((entry) => fileAttributesExtension(entry.path)))].sort();
}

export function listFileAttributeEolValues(entries, field) {
  requireEntries(entries);
  if (field !== "index_eol" && field !== "worktree_eol") throw new RangeError(`Unknown EOL field: ${field}`);
  return [...new Set(entries.map((entry) => requireString(entry[field], field)))].sort();
}

export function searchFileAttributeEntries(entries, query) {
  requireEntries(entries);
  const normalized = requireString(query, "query").trim().toLocaleLowerCase();
  if (!normalized) return [...entries];
  return entries.filter((entry) => {
    const path = entryPath(entry);
    return path !== null && path.toLocaleLowerCase().includes(normalized);
  });
}

export function filterFileAttributeEntriesByDirectory(entries, directory) {
  requireEntries(entries);
  const value = requireString(directory, "directory");
  if (value === FILE_ATTRIBUTES_DIRECTORY_ALL) return [...entries];
  if (value.length === 0) throw new RangeError("directory must not be empty");
  return entries.filter((entry) => {
    const path = entryPath(entry);
    return path !== null && fileAttributesDirectory(path) === value;
  });
}

function entryFlags(entry) {
  return entry && Array.isArray(entry.flags) ? entry.flags : [];
}

export function fileAttributeHasFlag(entry, flag) {
  requireString(flag, "flag");
  return entryFlags(entry).includes(flag);
}

export function fileAttributeEolMatches(entry, filter) {
  requireString(filter, "filter");
  if (filter === EOL_FILTER_ALL) return true;
  if (filter === EOL_FILTER_ANOMALOUS || filter === EOL_FILTER_DIFFERENT) {
    return fileAttributeHasFlag(entry, "different");
  }
  if (filter === EOL_FILTER_MIXED || filter === EOL_FILTER_UNKNOWN) {
    return fileAttributeHasFlag(entry, filter);
  }
  throw new RangeError(`Unknown EOL filter: ${filter}`);
}

export function filterFileAttributeEntriesByEol(entries, filter) {
  requireEntries(entries);
  return entries.filter((entry) => fileAttributeEolMatches(entry, filter));
}

export function filterFileAttributeEntries(entries, { query, directory, eol, extension, indexEol, worktreeEol, selectedPaths, selectedOnly }) {
  requireEntries(entries);
  requireString(query, "query");
  requireString(directory, "directory");
  requireString(eol, "eol");
  requireString(extension, "extension");
  requireString(indexEol, "indexEol");
  requireString(worktreeEol, "worktreeEol");
  requirePaths(selectedPaths);
  if (typeof selectedOnly !== "boolean") throw new TypeError("selectedOnly must be provided explicitly");
  const selected = new Set(selectedPaths);
  const searched = searchFileAttributeEntries(entries, query);
  const byDirectory = filterFileAttributeEntriesByDirectory(searched, directory);
  return filterFileAttributeEntriesByEol(byDirectory, eol).filter((entry) => (
    (extension === FILE_ATTRIBUTES_EXTENSION_ALL || fileAttributesExtension(entry.path) === extension)
    && (indexEol === FILE_ATTRIBUTES_EOL_VALUE_ALL || entry.index_eol === indexEol)
    && (worktreeEol === FILE_ATTRIBUTES_EOL_VALUE_ALL || entry.worktree_eol === worktreeEol)
    && (!selectedOnly || selected.has(entry.path))
  ));
}

/** Preserve current choices and add only displayed paths, in displayed order. */
export function selectDisplayedFileAttributePaths(entries, selectedPaths) {
  requireEntries(entries);
  requirePaths(selectedPaths);
  if (selectedPaths.length > FILE_ATTRIBUTES_MAX_ATTRIBUTE_PATHS) throw new RangeError("too many selected paths");
  const paths = new Set(selectedPaths);
  for (const entry of entries) {
    if (paths.size >= FILE_ATTRIBUTES_MAX_ATTRIBUTE_PATHS) break;
    const path = entryPath(entry);
    if (path === null) throw new TypeError("displayed entries need explicit paths");
    paths.add(path);
  }
  return [...paths];
}

export function sortFileAttributeEntries(entries, order) {
  requireEntries(entries);
  if (order !== "asc" && order !== "desc") throw new RangeError(`Unknown file attribute order: ${order}`);
  const multiplier = order === "asc" ? 1 : -1;
  return [...entries].sort((left, right) => multiplier * comparePaths(left, right));
}

function attributeMap(entry) {
  if (!entry || !entry.attributes || typeof entry.attributes !== "object" || Array.isArray(entry.attributes)) {
    throw new TypeError("attribute entry must contain an attributes object");
  }
  return entry.attributes;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function attributeValue(map, name) {
  return hasOwn(map, name) ? map[name] : null;
}

/**
 * Compare two successful check-attr entries.  ``present`` is carried next to
 * each value because null means "not returned by --all", while the Git value
 * ``unspecified`` is a real returned value with a different meaning.
 */
export function compareFileAttributes(left, right) {
  const leftPath = entryPath(left);
  const rightPath = entryPath(right);
  if (leftPath === null || rightPath === null) throw new TypeError("attribute entries need explicit paths");
  const leftMap = attributeMap(left);
  const rightMap = attributeMap(right);
  const names = [...new Set([...Object.keys(leftMap), ...Object.keys(rightMap)])].sort((a, b) => a.localeCompare(b));
  const rows = names.map((name) => {
    const leftPresent = hasOwn(leftMap, name);
    const rightPresent = hasOwn(rightMap, name);
    const leftValue = attributeValue(leftMap, name);
    const rightValue = attributeValue(rightMap, name);
    return {
      name,
      left: leftValue,
      right: rightValue,
      leftPresent,
      rightPresent,
      same: leftPresent === rightPresent && leftValue === rightValue,
    };
  });
  return {
    leftPath,
    rightPath,
    rows,
    differences: rows.filter((row) => !row.same),
    identical: rows.every((row) => row.same),
  };
}

export const compareAttributes = compareFileAttributes;
export const attributeComparison = compareFileAttributes;

export function attributesForPath(entries, path) {
  requireEntries(entries);
  requireString(path, "path");
  const entry = entries.find((item) => item && item.path === path);
  return entry || null;
}

export function fileAttributesEolQuery(path) {
  requireString(path, "path");
  return new URLSearchParams({ path }).toString();
}

export const eolInventoryQuery = fileAttributesEolQuery;

export function fileAttributesRequestBody(path, paths, mode) {
  requireString(path, "path");
  if (!Array.isArray(paths)) throw new TypeError("paths must be provided explicitly");
  if (paths.length > FILE_ATTRIBUTES_MAX_ATTRIBUTE_PATHS) throw new RangeError("too many attribute paths");
  if (!paths.every((item) => typeof item === "string")) throw new TypeError("attribute paths must be strings");
  if (!FILE_ATTRIBUTE_MODES.includes(mode)) throw new RangeError(`Unknown attribute mode: ${mode}`);
  return { path, paths: [...paths], mode };
}

export const inspectAttributesBody = fileAttributesRequestBody;

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  const protectedText = /^[\s]*[=+\-@]/u.test(text) ? `'${text}` : text;
  return `"${protectedText.replaceAll('"', '""')}"`;
}

function attributesText(attributes) {
  return Object.keys(attributes).sort().map((key) => `${key}=${attributes[key]}`).join("; ");
}

/** Export the current EOL inventory plus the latest explicit attribute diagnosis. */
export function fileAttributesCsv(entries, inspectedEntries, mode) {
  requireEntries(entries);
  requireEntries(inspectedEntries);
  if (mode !== null && !FILE_ATTRIBUTE_MODES.includes(mode)) throw new RangeError(`Unknown attribute mode: ${mode}`);
  const byPath = new Map();
  const names = new Set();
  for (const entry of inspectedEntries) {
    const path = entryPath(entry);
    if (path === null) throw new TypeError("attribute entries need explicit paths");
    const attributes = attributeMap(entry);
    byPath.set(path, attributes);
    Object.keys(attributes).forEach((name) => names.add(name));
  }
  const attributeNames = [...names].sort((a, b) => a.localeCompare(b));
  const header = ["path", "index_eol", "worktree_eol", "attribute_eol", "eol_status", "attributes", "attribute_mode", ...attributeNames.map((name) => `attribute:${name}`)];
  const rows = entries.map((entry) => {
    const attributes = byPath.get(entry.path) || {};
    return [
      entry.path,
      entry.index_eol,
      entry.worktree_eol,
      entry.attribute_eol,
      entry.eol_status,
      attributesText(attributes),
      mode,
      ...attributeNames.map((name) => hasOwn(attributes, name) ? attributes[name] : null),
    ];
  });
  return "\uFEFF" + [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export const eolAttributesCsv = fileAttributesCsv;

/** Keep the bounded inventory and the actual successful attribute evaluation distinct. */
export function fileAttributesJson(entries, { repositoryPath, inventory, filters, selectedPaths, attributeResult }) {
  requireEntries(entries);
  requireString(repositoryPath, "repositoryPath");
  requireEntries(inventory.entries);
  requirePaths(selectedPaths);
  if (typeof inventory.truncated !== "boolean" || typeof inventory.limit !== "number" || typeof inventory.byte_limit !== "number") {
    throw new TypeError("inventory coverage must be provided explicitly");
  }
  for (const field of ["query", "directory", "eol", "extension", "indexEol", "worktreeEol", "order"]) {
    requireString(filters[field], `filters.${field}`);
  }
  if (typeof filters.selectedOnly !== "boolean") throw new TypeError("filters.selectedOnly must be provided explicitly");
  const displayed = new Set(entries.map((entry) => entry.path));
  let evaluation = null;
  if (attributeResult !== null) {
    if (!FILE_ATTRIBUTE_MODES.includes(attributeResult.mode)) throw new RangeError("attribute result needs its actual mode");
    requireEntries(attributeResult.entries);
    requirePaths(attributeResult.paths);
    evaluation = {
      mode: attributeResult.mode,
      requested_paths: [...attributeResult.paths],
      returned_count: attributeResult.entries.length,
      limit: attributeResult.limit,
      byte_limit: attributeResult.byte_limit,
      command: attributeResult.command,
      entries: attributeResult.entries.filter((entry) => displayed.has(entry.path)),
    };
  }
  return JSON.stringify({
    repository_path: repositoryPath,
    inventory: {
      returned_count: inventory.entries.length,
      truncated: inventory.truncated,
      limit: inventory.limit,
      byte_limit: inventory.byte_limit,
      command: inventory.command,
    },
    filters: { ...filters },
    selected_paths: [...selectedPaths],
    displayed_count: entries.length,
    entries,
    attribute_evaluation: evaluation,
  }, null, 2) + "\n";
}

/** One JSON string per line preserves tabs, newlines, quotes, and whitespace. */
export function fileAttributePathsJsonl(entries) {
  requireEntries(entries);
  return entries.map((entry) => {
    const path = entryPath(entry);
    if (path === null) throw new TypeError("displayed entries need explicit paths");
    return JSON.stringify(path);
  }).join("\n");
}

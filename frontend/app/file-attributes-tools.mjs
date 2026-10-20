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

export function filterFileAttributeEntries(entries, { query, directory, eol }) {
  requireEntries(entries);
  requireString(query, "query");
  requireString(directory, "directory");
  requireString(eol, "eol");
  const searched = searchFileAttributeEntries(entries, query);
  const byDirectory = filterFileAttributeEntriesByDirectory(searched, directory);
  return filterFileAttributeEntriesByEol(byDirectory, eol);
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

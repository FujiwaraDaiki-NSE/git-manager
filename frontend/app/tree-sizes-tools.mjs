export const TREE_SIZES_MAX_ENTRIES = 10000;
export const TREE_SIZE_EXTENSION_ALL = "all";
export const TREE_SIZE_EXTENSION_NONE = "none";
export const TREE_SIZE_FILTER_ALL = "all";
export const TREE_SIZE_FILTER_KNOWN = "known";
export const TREE_SIZE_FILTER_UNKNOWN = "unknown";

function requiredString(value, name) {
  if (typeof value !== "string") throw new TypeError(`${name} must be provided explicitly`);
  return value;
}

function requiredBoolean(value, name) {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be provided explicitly`);
  return value;
}

function requiredRecord(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be provided explicitly`);
  }
  return value;
}

function requiredNullableSafeInteger(value, name, minimum) {
  if (value === null) return;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be null or a safe integer >= ${minimum}`);
  }
}

/** Build a tree-size request with the repository and revision always present. */
export function treeSizesQuery(path, revision) {
  requiredString(path, "path");
  requiredString(revision, "revision");
  return new URLSearchParams({ path, revision }).toString();
}

/** Return the user-facing file kind derived from Git's mode/object type. */
export function treeSizeKind(entry) {
  if (entry && (entry.type === "commit" || entry.mode === "160000")) return "gitlink";
  if (entry && entry.mode === "120000") return "symlink";
  return "regular";
}

export function treeSizeKindLabel(kind) {
  if (kind === "gitlink") return "gitlink";
  if (kind === "symlink") return "symlink";
  return "regular";
}

export function treeSizeDirectory(path) {
  requiredString(path, "path");
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

export function treeSizeEntryInDirectory(path, directory) {
  requiredString(path, "path");
  requiredString(directory, "directory");
  const prefix = directory ? `${directory}/` : "";
  return path.startsWith(prefix) && !path.slice(prefix.length).includes("/");
}

/** Return the lower-case extension of a displayed path, including its dot.
 * Plain dotfiles such as `.gitignore`, names without a dot, and trailing dots
 * are deliberately extensionless.  A dotfile with a suffix such as
 * `.env.local` uses the final suffix `.local`.
 */
export function treeSizeExtension(path) {
  requiredString(path, "path");
  const separator = path.lastIndexOf("/");
  const basename = path.slice(separator + 1);
  const dot = basename.lastIndexOf(".");
  if (dot <= 0 || dot === basename.length - 1) return null;
  return basename.slice(dot).toLocaleLowerCase();
}

/** List the exact extensions present in the supplied path snapshot. */
export function listTreeSizeExtensions(entries) {
  if (!Array.isArray(entries)) throw new TypeError("entries must be an array");
  const extensions = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry.path !== "string") throw new TypeError("tree-size entries must include path");
    const extension = treeSizeExtension(entry.path);
    extensions.add(extension === null ? TREE_SIZE_EXTENSION_NONE : extension);
  }
  return [...extensions].sort((left, right) => {
    if (left === TREE_SIZE_EXTENSION_NONE) return -1;
    if (right === TREE_SIZE_EXTENSION_NONE) return 1;
    return left.localeCompare(right, undefined, { sensitivity: "base" });
  });
}

function validateTreeSizeExtension(extension) {
  requiredString(extension, "extension");
  if (extension === TREE_SIZE_EXTENSION_ALL || extension === TREE_SIZE_EXTENSION_NONE) return;
  if (!/^\.[^./]+$/u.test(extension)) throw new RangeError(`Unknown tree-size extension: ${extension}`);
}

function treeSizeObjectKey(entry) {
  if (!entry || typeof entry !== "object" || typeof entry.type !== "string" || typeof entry.hash !== "string") {
    throw new TypeError("tree-size entries must include type and hash");
  }
  return `${entry.type}\u0000${entry.hash}`;
}

/** Return the exact type+hash key used to identify one object in this view. */
export function treeSizeObjectKeyForEntry(entry) {
  return treeSizeObjectKey(entry);
}

/** Keep only paths whose type+hash object is referenced more than once. */
export function duplicateTreeSizeEntries(entries) {
  if (!Array.isArray(entries)) throw new TypeError("entries must be an array");
  const counts = new Map();
  for (const entry of entries) {
    const key = treeSizeObjectKey(entry);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return entries.filter((entry) => counts.get(treeSizeObjectKey(entry)) > 1);
}

function pathWithinDirectory(path, directory) {
  const prefix = directory ? `${directory}/` : "";
  return path === directory || path.startsWith(prefix);
}

/** Filter retrieved entries without claiming to know anything outside them. */
export function filterTreeSizeEntries(entries, {
  directory,
  pathQuery,
  kind,
  minimumBytes,
  maximumBytes,
  sizeFilter,
  extension,
  duplicateOnly,
}) {
  requiredString(directory, "directory");
  requiredString(pathQuery, "pathQuery");
  requiredString(kind, "kind");
  requiredNullableSafeInteger(minimumBytes, "minimumBytes", 1);
  requiredNullableSafeInteger(maximumBytes, "maximumBytes", 0);
  requiredString(sizeFilter, "sizeFilter");
  if (![TREE_SIZE_FILTER_ALL, TREE_SIZE_FILTER_KNOWN, TREE_SIZE_FILTER_UNKNOWN].includes(sizeFilter)) {
    throw new RangeError(`Unknown tree-size size filter: ${sizeFilter}`);
  }
  validateTreeSizeExtension(extension);
  requiredBoolean(duplicateOnly, "duplicateOnly");
  if (!Array.isArray(entries)) throw new TypeError("entries must be an array");
  const query = pathQuery.toLocaleLowerCase();
  const duplicateKeys = duplicateOnly
    ? new Set(duplicateTreeSizeEntries(entries).map((entry) => treeSizeObjectKey(entry)))
    : null;
  return entries.filter((entry) => {
    if (!pathWithinDirectory(entry.path, directory)) return false;
    if (query && !entry.path.toLocaleLowerCase().includes(query)) return false;
    if (kind !== "all" && treeSizeKind(entry) !== kind) return false;
    if (minimumBytes !== null && minimumBytes !== undefined && entry.size !== null && entry.size < minimumBytes) return false;
    if (minimumBytes !== null && minimumBytes !== undefined && entry.size === null) return false;
    if (maximumBytes !== null && maximumBytes !== undefined && entry.size !== null && entry.size > maximumBytes) return false;
    if (maximumBytes !== null && maximumBytes !== undefined && entry.size === null) return false;
    if (sizeFilter === TREE_SIZE_FILTER_KNOWN && entry.size === null) return false;
    if (sizeFilter === TREE_SIZE_FILTER_UNKNOWN && entry.size !== null) return false;
    if (extension !== TREE_SIZE_EXTENSION_ALL) {
      const entryExtension = treeSizeExtension(entry.path);
      if (extension === TREE_SIZE_EXTENSION_NONE ? entryExtension !== null : entryExtension !== extension.toLocaleLowerCase()) return false;
    }
    if (duplicateKeys && !duplicateKeys.has(treeSizeObjectKey(entry))) return false;
    return true;
  });
}

function comparePath(left, right) {
  return left.path.localeCompare(right.path, undefined, { numeric: true });
}

/** Sort with unknown sizes last in either direction, then stable path order. */
export function sortTreeSizeEntries(entries, order, direction) {
  requiredString(order, "order");
  requiredString(direction, "direction");
  if (!Array.isArray(entries)) throw new TypeError("entries must be an array");
  const sign = direction === "ascending" ? 1 : direction === "descending" ? -1 : null;
  if (sign === null) throw new RangeError("direction must be ascending or descending");
  return [...entries].sort((left, right) => {
    if (order === "size") {
      const leftUnknown = left.size === null;
      const rightUnknown = right.size === null;
      if (leftUnknown !== rightUnknown) return leftUnknown ? 1 : -1;
      if (!leftUnknown && left.size !== right.size) return (left.size - right.size) * sign;
    } else if (order !== "path") {
      throw new RangeError("order must be path or size");
    }
    return comparePath(left, right) * (order === "path" ? sign : 1);
  });
}

function emptyAggregate(path) {
  return { path, totalBytes: 0, fileCount: 0, unknownSizeCount: 0 };
}

/** Aggregate immediate child directories from the retrieved path inventory. */
export function aggregateTreeSizeDirectories(entries, directory) {
  requiredString(directory, "directory");
  if (!Array.isArray(entries)) throw new TypeError("entries must be an array");
  const prefix = directory ? `${directory}/` : "";
  const aggregates = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.path !== "string" || !entry.path.startsWith(prefix)) continue;
    const remainder = entry.path.slice(prefix.length);
    const slash = remainder.indexOf("/");
    if (slash < 0) continue;
    const child = `${prefix}${remainder.slice(0, slash)}`;
    const aggregate = aggregates.get(child) || emptyAggregate(child);
    aggregate.fileCount += 1;
    if (entry.size === null) aggregate.unknownSizeCount += 1;
    else aggregate.totalBytes += entry.size;
    aggregates.set(child, aggregate);
  }
  return [...aggregates.values()].sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true }));
}

export function aggregateTreeSizeEntries(entries) {
  if (!Array.isArray(entries)) throw new TypeError("entries must be an array");
  const totalBytes = entries.reduce((total, entry) => total + (entry.size === null ? 0 : entry.size), 0);
  return {
    totalBytes,
    fileCount: entries.length,
    unknownSizeCount: entries.filter((entry) => entry.size === null).length,
  };
}

/** Aggregate the visible path snapshot into distinct type+hash objects. */
export function aggregateTreeSizeObjects(entries) {
  if (!Array.isArray(entries)) throw new TypeError("entries must be an array");
  const objects = new Map();
  for (const entry of entries) {
    const key = treeSizeObjectKey(entry);
    const current = objects.get(key);
    if (current === undefined) {
      objects.set(key, {
        type: entry.type,
        hash: entry.hash,
        size: entry.size,
        referenceCount: 1,
        paths: [entry.path],
      });
      continue;
    }
    current.referenceCount += 1;
    current.paths.push(entry.path);
    // A size is known for the object only when every displayed reference
    // supplies the same known value. Any unknown or conflicting value stays
    // unknown; the UI must not infer a capacity from incomplete evidence.
    if (current.size === null || entry.size === null || current.size !== entry.size) current.size = null;
  }
  return [...objects.values()];
}

/** Compare ordinary path totals with distinct object totals for this view. */
export function aggregateTreeSizeObjectSummary(entries) {
  const pathSummary = aggregateTreeSizeEntries(entries);
  const objects = aggregateTreeSizeObjects(entries);
  const objectTotalBytes = objects.reduce((total, object) => total + (object.size === null ? 0 : object.size), 0);
  const objectUnknownSizeCount = objects.filter((object) => object.size === null).length;
  return {
    objects,
    pathTotalBytes: pathSummary.totalBytes,
    pathFileCount: pathSummary.fileCount,
    pathUnknownSizeCount: pathSummary.unknownSizeCount,
    objectTotalBytes,
    objectCount: objects.length,
    objectUnknownSizeCount,
    duplicateReferenceCount: Math.max(0, pathSummary.fileCount - objects.length),
  };
}

export function treeSizeBreadcrumbs(directory) {
  requiredString(directory, "directory");
  if (!directory) return [];
  const parts = directory.split("/");
  return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join("/") }));
}

function fullTreeSizeHash(value, name) {
  requiredString(value, name);
  if (!/^[0-9a-f]{40,64}$/iu.test(value)) throw new TypeError(`${name} must be a full object hash`);
  return value;
}

function treeSizeSnapshotConditions(conditions) {
  const value = requiredRecord(conditions, "conditions");
  requiredString(value.directory, "conditions.directory");
  requiredString(value.pathQuery, "conditions.pathQuery");
  requiredString(value.kind, "conditions.kind");
  requiredNullableSafeInteger(value.minimumBytes, "conditions.minimumBytes", 1);
  requiredNullableSafeInteger(value.maximumBytes, "conditions.maximumBytes", 0);
  requiredString(value.sizeFilter, "conditions.sizeFilter");
  validateTreeSizeExtension(value.extension);
  requiredBoolean(value.duplicateOnly, "conditions.duplicateOnly");
  requiredString(value.order, "conditions.order");
  requiredString(value.direction, "conditions.direction");
  return {
    directory: value.directory,
    pathQuery: value.pathQuery,
    kind: value.kind,
    minimumBytes: value.minimumBytes,
    maximumBytes: value.maximumBytes,
    sizeFilter: value.sizeFilter,
    extension: value.extension,
    duplicateOnly: value.duplicateOnly,
    order: value.order,
    direction: value.direction,
  };
}

/** Serialize visible rows with repository identity, immutable hash, coverage, and local conditions. */
export function treeSizesJson(entries, snapshot, conditions, repositoryPath) {
  if (!Array.isArray(entries)) throw new TypeError("entries must be an array");
  requiredString(repositoryPath, "repositoryPath");
  const value = requiredRecord(snapshot, "snapshot");
  const pinnedHash = fullTreeSizeHash(value.pinned_hash, "snapshot.pinned_hash");
  requiredString(value.revision, "snapshot.revision");
  if (!Number.isSafeInteger(value.file_count) || value.file_count < 0) throw new TypeError("snapshot.file_count must be a non-negative safe integer");
  if (!Number.isSafeInteger(value.unknown_size_count) || value.unknown_size_count < 0) throw new TypeError("snapshot.unknown_size_count must be a non-negative safe integer");
  if (typeof value.truncated !== "boolean") throw new TypeError("snapshot.truncated must be provided explicitly");
  if (!Number.isSafeInteger(value.limit) || value.limit < 0) throw new TypeError("snapshot.limit must be a non-negative safe integer");
  if (!Number.isSafeInteger(value.byte_limit) || value.byte_limit < 0) throw new TypeError("snapshot.byte_limit must be a non-negative safe integer");
  const localConditions = treeSizeSnapshotConditions(conditions);
  const visibleSummary = aggregateTreeSizeEntries(entries);
  return `${JSON.stringify({
    format: "gitdash-tree-sizes-v1",
    repository_path: repositoryPath,
    revision: value.revision,
    pinned_hash: pinnedHash,
    coverage: {
      retrieved_path_count: value.file_count,
      visible_path_count: entries.length,
      retrieved_unknown_size_count: value.unknown_size_count,
      visible_unknown_size_count: visibleSummary.unknownSizeCount,
      truncated: value.truncated,
      entry_limit: value.limit,
      byte_limit: value.byte_limit,
    },
    conditions: localConditions,
    entries: entries.map((entry) => ({
      path: entry.path,
      kind: treeSizeKind(entry),
      mode: entry.mode,
      type: entry.type,
      hash: entry.hash,
      size: entry.size,
    })),
  }, null, 2)}\n`;
}

/** Return one JSON-escaped path string per line, preserving visible order. */
export function treeSizesPathLines(entries) {
  if (!Array.isArray(entries)) throw new TypeError("entries must be an array");
  return entries.map((entry) => {
    if (!entry || typeof entry.path !== "string") throw new TypeError("tree-size entries must include path");
    return JSON.stringify(entry.path);
  }).join("\n");
}

export const treeSizesSnapshotJson = treeSizesJson;
export const treeSizesPathList = treeSizesPathLines;

/** Return null for an empty field or an invalid/non-positive explicit value. */
export function parseMinimumTreeSize(raw) {
  requiredString(raw, "minimumBytes");
  if (raw === "" || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function minimumTreeSizeError(raw) {
  requiredString(raw, "minimumBytes");
  if (raw === "") return null;
  if (!/^\d+$/.test(raw)) return "最小サイズは正の整数バイトで指定してください。";
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return "最小サイズは1以上の安全な整数バイトで指定してください。";
  return null;
}

/** Parse an optional maximum size. Zero is meaningful and remains explicit. */
export function parseMaximumTreeSize(raw) {
  requiredString(raw, "maximumBytes");
  if (raw === "" || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function maximumTreeSizeError(raw) {
  requiredString(raw, "maximumBytes");
  if (raw === "") return null;
  if (!/^\d+$/.test(raw)) return "最大サイズは0以上の整数バイトで指定してください。";
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) return "最大サイズは0以上の安全な整数バイトで指定してください。";
  return null;
}

/** Reject a reversed known size range instead of silently showing no rows. */
export function treeSizeRangeError(minimumBytes, maximumBytes) {
  requiredNullableSafeInteger(minimumBytes, "minimumBytes", 1);
  requiredNullableSafeInteger(maximumBytes, "maximumBytes", 0);
  if (minimumBytes !== null && maximumBytes !== null && minimumBytes > maximumBytes) {
    return "最小サイズは最大サイズ以下で指定してください。";
  }
  return null;
}

export function formatTreeSizeBytes(value) {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return "サイズ未取得";
  const bytes = `${Math.trunc(value).toLocaleString("en-US")} B`;
  if (value < 1024) return bytes;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let scaled = value;
  let index = -1;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  return `${bytes} (${scaled.toFixed(scaled < 10 ? 2 : scaled < 100 ? 1 : 0)} ${units[index]})`;
}

function csvCell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  // Excel and spreadsheet importers interpret these leading characters as a
  // formula.  A visible space keeps the original value inspectable while
  // making the cell plain text.
  if (/^\s*[=+\-@]/.test(text)) text = ` ${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/** Export only the already-filtered path rows, with a UTF-8 BOM and safe cells. */
export function treeSizesCsv(entries) {
  if (!Array.isArray(entries)) throw new TypeError("entries must be an array");
  const rows = [
    ["path", "kind", "mode", "type", "hash", "size_bytes"],
    ...entries.map((entry) => [entry.path, treeSizeKind(entry), entry.mode, entry.type, entry.hash, entry.size]),
  ];
  return `\ufeff${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

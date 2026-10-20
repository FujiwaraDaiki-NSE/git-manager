export const TREE_SIZES_MAX_ENTRIES = 10000;

function requiredString(value, name) {
  if (typeof value !== "string") throw new TypeError(`${name} must be provided explicitly`);
  return value;
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

function pathWithinDirectory(path, directory) {
  const prefix = directory ? `${directory}/` : "";
  return path === directory || path.startsWith(prefix);
}

/** Filter retrieved entries without claiming to know anything outside them. */
export function filterTreeSizeEntries(entries, { directory, pathQuery, kind, minimumBytes }) {
  requiredString(directory, "directory");
  requiredString(pathQuery, "pathQuery");
  requiredString(kind, "kind");
  if (!Array.isArray(entries)) throw new TypeError("entries must be an array");
  const query = pathQuery.toLocaleLowerCase();
  return entries.filter((entry) => {
    if (!pathWithinDirectory(entry.path, directory)) return false;
    if (query && !entry.path.toLocaleLowerCase().includes(query)) return false;
    if (kind !== "all" && treeSizeKind(entry) !== kind) return false;
    if (minimumBytes !== null && minimumBytes !== undefined && entry.size !== null && entry.size < minimumBytes) return false;
    if (minimumBytes !== null && minimumBytes !== undefined && entry.size === null) return false;
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

export function treeSizeBreadcrumbs(directory) {
  requiredString(directory, "directory");
  if (!directory) return [];
  const parts = directory.split("/");
  return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join("/") }));
}

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

/** Pure helpers for the bounded Git ignore inventory and rule diagnosis. */

export const IGNORE_DIRECTORY_ALL = "/";
export const IGNORE_DIRECTORY_ROOT = ".";
export const IGNORE_PATH_LIMIT = 100;
export const IGNORE_PATH_LENGTH = 4096;
export const IGNORE_ORDERS = ["asc", "desc"];

function directoryOf(path) {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? IGNORE_DIRECTORY_ROOT : path.slice(0, separator);
}

function compareEntries(left, right) {
  return left.path.localeCompare(right.path, undefined, { sensitivity: "base" });
}

function validateCandidatePath(path) {
  if (typeof path !== "string" || path.length === 0) {
    throw new TypeError("Ignore candidate paths must be non-empty strings");
  }
  if (path.length > IGNORE_PATH_LENGTH || path.includes("\0")) {
    throw new RangeError("Ignore candidate path is too long or contains NUL");
  }
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith("\\\\")) {
    throw new RangeError("Ignore candidate paths must be repository-relative");
  }
  if (path.split(/[\\/]/u).some((part) => part === "..")) {
    throw new RangeError("Ignore candidate paths cannot contain parent traversal");
  }
  if (path === "." || path === "./" || path === ".\\") {
    throw new RangeError("Ignore candidate paths must identify a file path");
  }
  return path;
}

export function ignoreEntryDirectory(path) {
  if (typeof path !== "string" || path.length === 0) {
    throw new TypeError("Ignore entry path must be a non-empty string");
  }
  return directoryOf(path);
}

export function listIgnoreDirectories(entries) {
  if (!Array.isArray(entries)) throw new TypeError("Ignore entries must be an array");
  const directories = new Set(entries.map((entry) => ignoreEntryDirectory(entry.path)));
  return [...directories].sort((left, right) => {
    if (left === IGNORE_DIRECTORY_ROOT) return -1;
    if (right === IGNORE_DIRECTORY_ROOT) return 1;
    return left.localeCompare(right, undefined, { sensitivity: "base" });
  });
}

export function searchIgnoreEntries(entries, query) {
  if (!Array.isArray(entries)) throw new TypeError("Ignore entries must be an array");
  if (typeof query !== "string") throw new TypeError("Ignore search query must be a string");
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return [...entries];
  return entries.filter((entry) => [entry.path, entry.pattern, entry.source]
    .filter((value) => typeof value === "string")
    .some((value) => value.toLocaleLowerCase().includes(normalized)));
}

export function filterIgnoreEntriesByDirectory(entries, directory) {
  if (!Array.isArray(entries)) throw new TypeError("Ignore entries must be an array");
  if (typeof directory !== "string" || directory.length === 0) {
    throw new RangeError(`Unknown ignore directory: ${directory}`);
  }
  if (directory === IGNORE_DIRECTORY_ALL) return [...entries];
  return entries.filter((entry) => ignoreEntryDirectory(entry.path) === directory);
}

export function sortIgnoreEntries(entries, order = "asc") {
  if (!Array.isArray(entries)) throw new TypeError("Ignore entries must be an array");
  if (!IGNORE_ORDERS.includes(order)) throw new RangeError(`Unknown ignore order: ${order}`);
  const multiplier = order === "asc" ? 1 : -1;
  return [...entries].sort((left, right) => multiplier * compareEntries(left, right));
}

/** Preserve leading/trailing spaces in each line; blank lines are separators. */
export function parseIgnoreCandidates(value) {
  if (typeof value !== "string") throw new TypeError("Ignore candidates must be a string");
  const paths = value.split(/\r?\n/u).filter((path) => path.length > 0).map(validateCandidatePath);
  if (paths.length === 0) throw new RangeError("候補パスを1件以上入力してください");
  if (paths.length > IGNORE_PATH_LIMIT) {
    throw new RangeError(`候補パスは${IGNORE_PATH_LIMIT}件以下で指定してください`);
  }
  return paths;
}

export function checkIgnorePayload(path, paths) {
  if (typeof path !== "string" || path.length === 0) throw new TypeError("Repository path is required");
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > IGNORE_PATH_LIMIT) {
    throw new RangeError(`候補パスは1〜${IGNORE_PATH_LIMIT}件で指定してください`);
  }
  return { path, paths: paths.map(validateCandidatePath) };
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  const protectedText = /^[\s]*[=+\-@]/u.test(text) ? `'${text}` : text;
  return `"${protectedText.replaceAll('"', '""')}"`;
}

/** Formula-safe CSV for either inventory rows or explicit diagnosis rows. */
export function ignoreEntriesCsv(entries) {
  if (!Array.isArray(entries)) throw new TypeError("Ignore entries must be an array");
  const rows = [
    ["path", "ignored", "tracked", "source", "line", "pattern", "negation"],
    ...entries.map((entry) => [
      entry.path,
      entry.ignored,
      entry.tracked,
      entry.source,
      entry.line,
      entry.pattern,
      entry.negation,
    ]),
  ];
  return "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function ignoreEntryStatus(entry) {
  if (!entry || typeof entry !== "object") return "判定未取得";
  if (entry.ignored === true && entry.tracked === true) return "無視ルールあり・追跡済み";
  if (entry.ignored === true) return "無視される";
  if (entry.negation === true) return "無視しない（否定ルール）";
  return "無視ルールなし";
}

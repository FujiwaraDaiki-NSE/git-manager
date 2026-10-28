/** Pure helpers for the bounded Git ignore inventory and rule diagnosis. */

export const IGNORE_DIRECTORY_ALL = "/";
export const IGNORE_DIRECTORY_ROOT = ".";
export const IGNORE_PATH_LIMIT = 100;
export const IGNORE_PATH_LENGTH = 4096;
export const IGNORE_ORDERS = ["asc", "desc"];
export const IGNORE_PAGE_SIZES = [25, 50, 100];
export const IGNORE_OUTCOMES = ["all", "ignored", "tracked", "negation", "unmatched"];

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

/** A null source is an explicit row without rule metadata, not "all sources". */
export function listIgnoreSources(entries) {
  if (!Array.isArray(entries)) throw new TypeError("Ignore entries must be an array");
  const counts = new Map();
  for (const entry of entries) {
    if (counts.has(entry.source)) counts.set(entry.source, counts.get(entry.source) + 1);
    else counts.set(entry.source, 1);
  }
  return [...counts].map(([source, count]) => ({ source, count }))
    .sort((left, right) => {
      if (left.source === null) return 1;
      if (right.source === null) return -1;
      return left.source.localeCompare(right.source, undefined, { sensitivity: "base" });
    });
}

export function filterIgnoreEntriesBySource(entries, source) {
  if (!Array.isArray(entries)) throw new TypeError("Ignore entries must be an array");
  if (source !== null && typeof source !== "string") throw new TypeError("Ignore source must be a string or null");
  return entries.filter((entry) => entry.source === source);
}

/** Include the entire winning rule, so identical patterns in two files stay separate. */
export function ignoreRuleKey(entry) {
  return JSON.stringify([entry.source, entry.line, entry.pattern, entry.negation]);
}

export function summarizeIgnoreRules(entries) {
  if (!Array.isArray(entries)) throw new TypeError("Ignore entries must be an array");
  const rules = new Map();
  for (const entry of entries) {
    const key = ignoreRuleKey(entry);
    const existing = rules.get(key);
    if (existing) existing.count += 1;
    else rules.set(key, { key, source: entry.source, line: entry.line, pattern: entry.pattern, negation: entry.negation, count: 1 });
  }
  return [...rules.values()].sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

export function filterIgnoreEntriesByRule(entries, key) {
  if (!Array.isArray(entries)) throw new TypeError("Ignore entries must be an array");
  if (typeof key !== "string" || key.length === 0) throw new TypeError("Ignore rule key is required");
  return entries.filter((entry) => ignoreRuleKey(entry) === key);
}

export function paginateIgnoreEntries(entries, page, pageSize) {
  if (!Array.isArray(entries)) throw new TypeError("Ignore entries must be an array");
  if (!IGNORE_PAGE_SIZES.includes(pageSize)) throw new RangeError("Unknown ignore page size");
  const pageCount = Math.max(1, Math.ceil(entries.length / pageSize));
  if (!Number.isInteger(page) || page < 1 || page > pageCount) throw new RangeError("Ignore page is outside the available range");
  const start = (page - 1) * pageSize;
  return {
    entries: entries.slice(start, start + pageSize),
    page,
    pageCount,
    start: entries.length === 0 ? 0 : start + 1,
    end: Math.min(start + pageSize, entries.length),
    total: entries.length,
  };
}

export function ignoreEntryOutcome(entry) {
  if (entry.ignored === true && entry.tracked === true) return "tracked";
  if (entry.ignored === true) return "ignored";
  if (entry.negation === true) return "negation";
  return "unmatched";
}

export function summarizeIgnoreOutcomes(entries) {
  if (!Array.isArray(entries)) throw new TypeError("Ignore entries must be an array");
  const counts = { all: entries.length, ignored: 0, tracked: 0, negation: 0, unmatched: 0 };
  for (const entry of entries) counts[ignoreEntryOutcome(entry)] += 1;
  return counts;
}

export function filterIgnoreEntriesByOutcome(entries, outcome) {
  if (!Array.isArray(entries)) throw new TypeError("Ignore entries must be an array");
  if (!IGNORE_OUTCOMES.includes(outcome)) throw new RangeError("Unknown ignore outcome");
  return outcome === "all" ? [...entries] : entries.filter((entry) => ignoreEntryOutcome(entry) === outcome);
}

export function inspectIgnoreCandidates(value) {
  if (typeof value !== "string") throw new TypeError("Ignore candidates must be a string");
  const paths = value.split(/\r?\n/u).filter((path) => path.length > 0);
  const uniqueCount = new Set(paths).size;
  let error = null;
  try {
    parseIgnoreCandidates(value);
  } catch (caught) {
    error = caught.message;
  }
  return { count: paths.length, uniqueCount, duplicateCount: paths.length - uniqueCount, error };
}

/** Deduplication is explicit and keeps the first exact spelling, including spaces. */
export function deduplicateIgnoreCandidates(value) {
  if (typeof value !== "string") throw new TypeError("Ignore candidates must be a string");
  return [...new Set(value.split(/\r?\n/u).filter((path) => path.length > 0))].join("\n");
}

export function ignoreCandidatesMatchResult(value, submittedPaths) {
  if (!Array.isArray(submittedPaths)) throw new TypeError("Submitted ignore paths must be an array");
  let current;
  try {
    current = parseIgnoreCandidates(value);
  } catch {
    return false;
  }
  return current.length === submittedPaths.length && current.every((path, index) => path === submittedPaths[index]);
}

/** A line-input form cannot represent a filename containing CR or LF. */
export function ignoreEntriesCandidateText(entries) {
  if (!Array.isArray(entries)) throw new TypeError("Ignore entries must be an array");
  if (entries.length === 0 || entries.length > IGNORE_PATH_LIMIT) {
    throw new RangeError("候補への追加は1〜" + IGNORE_PATH_LIMIT + "件を選択してください。");
  }
  const paths = entries.map((entry) => {
    if (/[\r\n]/u.test(entry.path)) throw new RangeError("改行を含むパスは候補入力へ移せません。CSVで確認してください。");
    return validateCandidatePath(entry.path);
  });
  return paths.join("\n");
}

function markdownCell(value) {
  if (value === null) return "—";
  return String(value)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll("\\", "\\\\").replaceAll("|", "\\|")
    .replaceAll(String.fromCharCode(96), "\\" + String.fromCharCode(96))
    .replaceAll("[", "\\[").replaceAll("]", "\\]")
    .replaceAll("*", "\\*").replaceAll("_", "\\_")
    .replaceAll("\r", "\\r").replaceAll("\n", "\\n");
}

/** A report carries scope and snapshot caveats with the rule evidence. */
export function ignoreEntriesReport(entries, context) {
  if (!Array.isArray(entries)) throw new TypeError("Ignore entries must be an array");
  if (!context || typeof context.repository !== "string" || context.repository.length === 0
    || typeof context.scope !== "string" || !Array.isArray(context.filters)
    || context.filters.some((filter) => typeof filter !== "string")
    || ![true, false, null].includes(context.inventoryTruncated)
    || ![true, false, null].includes(context.inputCurrent)) {
    throw new TypeError("Ignore report context is required");
  }
  const lines = [
    "# Git ignore 調査",
    "",
    "リポジトリ: " + markdownCell(context.repository),
    "対象: " + markdownCell(context.scope) + " / " + entries.length + "件",
    ...context.filters.map((filter) => "条件: " + markdownCell(filter)),
  ];
  if (context.inventoryTruncated === true) lines.push("注意: 一覧は取得上限に達した一部です。リポジトリ全体の件数ではありません。");
  if (context.inventoryTruncated === false) lines.push("一覧: 取得時点の無視済みファイル一覧です。");
  if (context.inputCurrent === false) lines.push("注意: 候補入力は判定後に変更されています。以下は前回送信したパスの結果です。");
  if (context.inputCurrent === true) lines.push("候補入力: 判定に送信したパスと一致しています。");
  lines.push("", "| パス | 判定 | ルール元 | 行 | パターン | 追跡済み |", "| --- | --- | --- | --- | --- | --- |");
  for (const entry of entries) {
    lines.push("| " + [entry.path, ignoreEntryStatus(entry), entry.source, entry.line, entry.pattern, entry.tracked ? "はい" : "いいえ"].map(markdownCell).join(" | ") + " |");
  }
  return lines.join("\n") + "\n";
}

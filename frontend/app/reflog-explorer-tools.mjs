/** Pure helpers for the read-only reflog explorer. */

const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const IMMUTABLE_HASH_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const REF_DISALLOWED_PATTERN = /[\x00-\x20\x7f~^:?*\[\\]/u;

function isEmpty(value) {
  return value === null || value === undefined || value === "";
}

function assertExplicitFilters(query, startDate, endDate) {
  if (query === undefined || startDate === undefined || endDate === undefined) {
    throw new TypeError("query, startDate, and endDate must be provided explicitly; use null or an empty string for no filter");
  }
}

function daysInMonth(year, month) {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Return a real YYYY-MM-DD value, or null for an empty/malformed value. */
export function parseReflogCalendarDate(value) {
  if (isEmpty(value) || typeof value !== "string") return null;
  const match = CALENDAR_DATE_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return value;
}

/** Explain malformed or reversed inclusive calendar boundaries. */
export function reflogDateRangeError(startDate, endDate) {
  if (startDate === undefined || endDate === undefined) {
    throw new TypeError("startDate and endDate must be provided explicitly; use null or an empty string for no filter");
  }
  const start = parseReflogCalendarDate(startDate);
  const end = parseReflogCalendarDate(endDate);
  if (!isEmpty(startDate) && start === null) return "開始日は有効な日付（YYYY-MM-DD）で指定してください。";
  if (!isEmpty(endDate) && end === null) return "終了日は有効な日付（YYYY-MM-DD）で指定してください。";
  if (start !== null && end !== null && start > end) return "開始日は終了日以前の日付にしてください。";
  return null;
}

function reflogTimestamp(value) {
  if (typeof value !== "string" || value.length === 0) return NaN;
  if (parseReflogCalendarDate(value.slice(0, 10)) === null) return NaN;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

/** Convert an ISO instant to the browser's local inclusive calendar date. */
export function localReflogCalendarDate(value) {
  const timestamp = reflogTimestamp(value);
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Search only records already returned by the current reflog request. */
export function filterReflog(records, query, startDate, endDate) {
  assertExplicitFilters(query, startDate, endDate);
  if (!Array.isArray(records)) throw new TypeError("records must be an array");
  const terms = (typeof query === "string" ? query : "").trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const dateError = reflogDateRangeError(startDate, endDate);
  if (dateError) return [];
  const start = parseReflogCalendarDate(startDate);
  const end = parseReflogCalendarDate(endDate);
  const dateFilterActive = start !== null || end !== null;
  return records.filter((record) => {
    if (dateFilterActive) {
      // An active range cannot claim an unknown or malformed timestamp is
      // inside it.  The Git timestamp is the reflog operation time, not the
      // commit's author/committer time.
      const date = localReflogCalendarDate(record?.date);
      if (date === null) return false;
      if (start !== null && date < start) return false;
      if (end !== null && date > end) return false;
    }
    const text = [record?.action, record?.message, record?.hash, record?.actor]
      .filter((value) => typeof value === "string")
      .join("\n")
      .toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

/** Search without a date window; use filterReflog when a window is active. */
export function searchReflog(records, query) {
  if (query === undefined) throw new TypeError("query must be provided explicitly; use an empty string for no filter");
  return filterReflog(records, query, null, null);
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  // Spreadsheet applications may evaluate cells beginning with these
  // characters.  Prefixing a quote keeps the displayed value as data.
  const safe = /^[\s\uFEFF]*[=+\-@]/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

/** Export exactly the records that remain after filtering. */
export function reflogCsv(records) {
  if (!Array.isArray(records)) throw new TypeError("records must be an array");
  return "\uFEFF" + [
    ["hash", "selector", "message", "actor", "date"],
    ...records.map((record) => [record.hash, record.selector, record.message ?? record.action, record.actor, record.date]),
  ].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

export function reflogHashList(records) {
  if (!Array.isArray(records)) throw new TypeError("records must be an array");
  return records.map((record) => record.hash).filter((hash) => typeof hash === "string").join("\n");
}

/** Return whether a value is one of the exact refs accepted by the backend. */
export function isValidReflogRef(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return false;
  if (value === "HEAD" || value === "refs/stash") return true;
  if (!/^refs\/(?:heads|remotes)\//u.test(value)) return false;
  if (REF_DISALLOWED_PATTERN.test(value) || value.endsWith("/")) return false;
  const parts = value.split("/");
  if (value.includes("..") || value.includes("@{") || parts.some((part) => part.endsWith(".lock"))) return false;
  return parts.every((part) => part !== "" && part !== "." && part !== ".." && !part.startsWith(".") && !part.endsWith("."));
}

/** Build the only inventory request; callers must provide the selected ref. */
export function reflogRequestQuery(path, ref) {
  if (typeof path !== "string" || path.length === 0 || !isValidReflogRef(ref)) {
    throw new TypeError("path and an explicit HEAD or full reflog ref must be provided");
  }
  return new URLSearchParams({ path, ref }).toString();
}

/** POSIX shell quoting for a read-only command copied from the selected ref. */
export function reflogCommand(path, ref) {
  if (typeof path !== "string" || path.length === 0 || !isValidReflogRef(ref)) return null;
  const quotedPath = `'${path.replaceAll("'", "'\\''")}'`;
  const quotedRef = `'${ref.replaceAll("'", "'\\''")}'`;
  return `git -C ${quotedPath} log -g --date=iso-strict ${quotedRef}`;
}

/** Hashes are safe commit targets for the existing /api/repo/commit endpoint. */
export function isReflogCommitHash(value) {
  return typeof value === "string" && IMMUTABLE_HASH_PATTERN.test(value);
}

// Short aliases keep the helper module easy to consume from focused tests and
// make its names parallel with the branch/file-history explorers.
export const historyDateRangeError = reflogDateRangeError;
export const localCalendarDate = localReflogCalendarDate;
export const historyCsv = reflogCsv;


/**
 * Pure helpers for the read-only stash explorer.
 *
 * The inventory order returned by Git is part of the view contract. Every
 * filter and sort below returns a new array so a visible investigation never
 * mutates the authoritative snapshot held by the component.
 */

const STASH_ORDERS = Object.freeze(["git", "newest", "oldest", "subject"]);

const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

function isEmpty(value) {
  return value === null || value === "";
}

function assertStashes(stashes) {
  if (!Array.isArray(stashes)) throw new TypeError("stashes must be an array");
}

function assertExplicitFilters(query, startDate, endDate) {
  if (query === undefined || startDate === undefined || endDate === undefined) {
    throw new TypeError("query, startDate, and endDate must be provided explicitly; use null or an empty string for no filter");
  }
  if (typeof query !== "string") throw new TypeError("query must be a string; use an empty string for no filter");
}

function daysInMonth(year, month) {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Return an exact YYYY-MM-DD value when it is a real calendar date. */
export function parseStashCalendarDate(value) {
  if (isEmpty(value) || typeof value !== "string") return null;
  const match = CALENDAR_DATE_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return value;
}

/** Explain malformed or reversed inclusive local-calendar boundaries. */
export function stashDateRangeError(startDate, endDate) {
  if (startDate === undefined || endDate === undefined) {
    throw new TypeError("startDate and endDate must be provided explicitly; use null or an empty string for no filter");
  }
  const start = parseStashCalendarDate(startDate);
  const end = parseStashCalendarDate(endDate);
  if (!isEmpty(startDate) && start === null) return "開始日は有効な日付（YYYY-MM-DD）で指定してください。";
  if (!isEmpty(endDate) && end === null) return "終了日は有効な日付（YYYY-MM-DD）で指定してください。";
  if (start !== null && end !== null && start > end) return "開始日は終了日以前の日付にしてください。";
  return null;
}

function stashTimestamp(value) {
  if (typeof value !== "string" || value.length === 0) return NaN;
  // Date.parse normalizes some malformed calendar values. Validate the date
  // component first so an unknown stash date is never moved to another day.
  if (parseStashCalendarDate(value.slice(0, 10)) === null) return NaN;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

/** Convert an ISO stash instant to the browser's local calendar date. */
export function localStashCalendarDate(value) {
  const timestamp = stashTimestamp(value);
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Search stash subjects and immutable hashes. */
export function searchStashes(stashes, query) {
  assertStashes(stashes);
  if (typeof query !== "string") throw new TypeError("query must be a string; use an empty string for no filter");
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return [...stashes];
  return stashes.filter((stash) => [stash?.subject, stash?.hash]
    .filter((value) => typeof value === "string")
    .some((value) => value.toLocaleLowerCase().includes(needle)));
}

function matchesStashDate(stash, startDate, endDate) {
  const start = parseStashCalendarDate(startDate);
  const end = parseStashCalendarDate(endDate);
  if (start === null && end === null) return true;
  const date = localStashCalendarDate(stash?.date);
  // A finite range cannot claim that an unknown stash date belongs inside it.
  if (date === null) return false;
  if (start !== null && date < start) return false;
  if (end !== null && date > end) return false;
  return true;
}

/** Search and filter the stash snapshot using explicit local-calendar bounds. */
export function filterStashes(stashes, query, startDate, endDate) {
  assertStashes(stashes);
  assertExplicitFilters(query, startDate, endDate);
  if (stashDateRangeError(startDate, endDate)) return [];
  const needle = query.trim().toLocaleLowerCase();
  return stashes.filter((stash) => {
    if (needle && ![stash?.subject, stash?.hash]
      .filter((value) => typeof value === "string")
      .some((value) => value.toLocaleLowerCase().includes(needle))) return false;
    return matchesStashDate(stash, startDate, endDate);
  });
}

function knownSubject(value) {
  return typeof value === "string" && value.length > 0;
}

/** Sort without mutating the Git inventory. Unknown dates are always last. */
export function sortStashes(stashes, order) {
  assertStashes(stashes);
  if (!STASH_ORDERS.includes(order)) throw new RangeError(`Unknown stash order: ${order}`);
  if (order === "git") return [...stashes];
  return stashes.map((stash, index) => ({ stash, index })).sort((left, right) => {
    const leftDate = stashTimestamp(left.stash?.date);
    const rightDate = stashTimestamp(right.stash?.date);
    // Unknown dates stay after known dates for every semantic order. The Git
    // order remains untouched because it is already authoritative.
    if (!Number.isFinite(leftDate) && Number.isFinite(rightDate)) return 1;
    if (Number.isFinite(leftDate) && !Number.isFinite(rightDate)) return -1;
    if (order === "subject") {
      const leftKnown = knownSubject(left.stash?.subject);
      const rightKnown = knownSubject(right.stash?.subject);
      if (!leftKnown && rightKnown) return 1;
      if (leftKnown && !rightKnown) return -1;
      if (leftKnown && rightKnown) {
        const result = left.stash.subject.localeCompare(right.stash.subject, undefined, { sensitivity: "base" });
        if (result !== 0) return result;
      }
      return left.index - right.index;
    }
    if (Number.isFinite(leftDate) && Number.isFinite(rightDate) && leftDate !== rightDate) {
      return order === "oldest" ? leftDate - rightDate : rightDate - leftDate;
    }
    return left.index - right.index;
  }).map(({ stash }) => stash);
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  // Prefix spreadsheet formula starters, including values preceded by spaces,
  // tabs, a BOM, or a newline, before RFC-style quote escaping.
  const safe = /^[\s\uFEFF]*[=+\-@]/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

const STASH_CSV_HEADERS = Object.freeze(["hash", "selector", "subject", "date"]);

/** Serialize exactly the already-filtered stash inventory as formula-safe CSV. */
export function stashInventoryCsv(stashes) {
  assertStashes(stashes);
  const rows = [
    STASH_CSV_HEADERS,
    ...stashes.map((stash) => [stash?.hash, stash?.selector, stash?.subject, stash?.date]),
  ];
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/** Copy the full immutable hashes represented by the supplied visible rows. */
export function stashHashList(stashes) {
  assertStashes(stashes);
  return stashes.map((stash) => stash?.hash).filter((hash) => typeof hash === "string").join("\n");
}

/** Return adjacent rows in the supplied visible order; never wrap or fallback. */
export function adjacentStashes(stashes, selectedHash) {
  assertStashes(stashes);
  if (selectedHash === undefined) throw new TypeError("selectedHash must be provided explicitly; use null for no selection");
  if (selectedHash !== null && typeof selectedHash !== "string") throw new TypeError("selectedHash must be a string or null");
  const index = selectedHash === null ? -1 : stashes.findIndex((stash) => stash?.hash === selectedHash);
  return {
    index,
    count: stashes.length,
    previous: index > 0 ? stashes[index - 1] : null,
    next: index >= 0 && index + 1 < stashes.length ? stashes[index + 1] : null,
  };
}

function markdownValue(value) {
  if (value === null || value === undefined || value === "") return "未取得";
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/[\\`*_{}\[\]()#+.!|~]/g, "\\$&")
    .replace(/\r\n|\r|\n/g, "<br>");
}

function markdownExactValue(value) {
  if (value === null || value === undefined || value === "") return "未取得";
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replace(/\r\n|\r|\n/g, "<br>");
}

function booleanValue(value) {
  return value === true ? "true" : value === false ? "false" : "unknown";
}

function stashPartMarkdown(label, part) {
  const files = Array.isArray(part?.files) ? part.files : [];
  const paths = files.map((file) => typeof file?.path === "string" ? file.path : null);
  return [
    `## ${label}`,
    "",
    `- available: ${booleanValue(part?.available)}`,
    `- file_count: ${files.length}`,
    `- patch_truncated: ${booleanValue(part?.patch_truncated)}`,
    "- file_paths:",
    ...(paths.length ? paths.map((path) => `  - ${markdownValue(path)}`) : ["  - なし"]),
    "",
  ];
}

/** Build an escaped, exact handoff report for one selected stash. */
export function stashInvestigationMarkdown(detail, path) {
  if (detail === null || typeof detail !== "object") throw new TypeError("stash detail must be provided explicitly");
  if (typeof path !== "string" || path.length === 0) throw new TypeError("repository path must be a non-empty string");
  return [
    "# gitdash stash investigation",
    "",
    "## stash",
    "",
    `- repository_path: ${markdownValue(path)}`,
    `- immutable_hash: ${markdownExactValue(detail.hash)}`,
    `- selector: ${markdownExactValue(detail.selector)}`,
    `- date: ${markdownExactValue(detail.date)}`,
    `- subject: ${markdownValue(detail.subject)}`,
    "",
    ...stashPartMarkdown("tracked", detail.tracked),
    ...stashPartMarkdown("untracked", detail.untracked),
    "- read_only: true",
  ].join("\n");
}

/**
 * Add the host repository path to a backend command for direct terminal use.
 * The backend command contains only fixed Git arguments and the immutable
 * object id; this helper supplies the checkout context known by the browser.
 */
export function stashCommand(path, command) {
  if (typeof path !== "string" || path.length === 0) return null;
  if (!command) return null;
  const quotedPath = `'${path.replaceAll("'", "'\\''")}'`;
  if (!command.startsWith("git ")) return null;
  if (/\bstash\s+(?:apply|pop|drop|clear|push|store)\b/.test(command)) return null;
  return `git -C ${quotedPath} ${command.slice(4)}`;
}

/** Return a stable label for a file part in the UI. */
export function stashPartLabel(part) {
  return part === "tracked" ? "追跡済みの変更" : "未追跡ファイル";
}


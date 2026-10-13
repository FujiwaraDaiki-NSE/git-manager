/**
 * Pure helpers for the project activity explorer.
 *
 * Activity records are snapshots: a missing value is unknown, not an empty
 * value that can be inferred from another field.  The explorer therefore
 * keeps exact filter values and only claims a date match when an event has a
 * valid timestamp.
 */

export const UNKNOWN_AUTHOR_FILTER = "__gitdash_unknown_activity_author__";
export const AUTHOR_FILTER_PREFIX = "__gitdash_activity_author__:";
export const UNKNOWN_BRANCH_FILTER = "__gitdash_unknown_activity_branch__";
export const BRANCH_FILTER_PREFIX = "__gitdash_activity_branch__:";

const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

function isEmpty(value) {
  return value === null || value === undefined || value === "";
}

function assertExplicitOptions(options) {
  if (options === null || typeof options !== "object") {
    throw new TypeError("activity filter options must be provided explicitly");
  }
  const required = ["authorFilter", "branchFilter", "startDate", "endDate"];
  if (required.some((key) => options[key] === undefined)) {
    throw new TypeError(`${required.join(", ")} must be provided explicitly; use null or an empty string for no filter`);
  }
}

function daysInMonth(year, month) {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Return an exact YYYY-MM-DD value when it is a real calendar date. */
function parseCalendarDate(value) {
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
export function activityDateRangeError(startDate, endDate) {
  if (startDate === undefined || endDate === undefined) {
    throw new TypeError("startDate and endDate must be provided explicitly; use null or an empty string for no filter");
  }
  const start = parseCalendarDate(startDate);
  const end = parseCalendarDate(endDate);
  if (!isEmpty(startDate) && start === null) return "開始日は有効な日付（YYYY-MM-DD）で指定してください。";
  if (!isEmpty(endDate) && end === null) return "終了日は有効な日付（YYYY-MM-DD）で指定してください。";
  if (start !== null && end !== null && start > end) return "開始日は終了日以前の日付にしてください。";
  return null;
}

function activityTimestamp(value) {
  if (typeof value !== "string" || value.length === 0) return NaN;
  // Date.parse normalizes some malformed dates. Validate the calendar part
  // first so an unknown event does not become a different known date.
  if (parseCalendarDate(value.slice(0, 10)) === null) return NaN;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

/** Convert an event instant into the browser's local calendar date. */
export function localCalendarDate(value) {
  const timestamp = activityTimestamp(value);
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function knownText(value) {
  return typeof value === "string" && value.length > 0;
}

function eventAuthor(event) {
  return knownText(event.author) ? event.author : null;
}

/** Return unique exact author values from the supplied activity snapshot. */
export function activityAuthors(events) {
  return Array.from(new Set(events.map(eventAuthor).filter((value) => value !== null)))
    .sort((left, right) => left.localeCompare(right));
}

export function hasUnknownAuthor(events) {
  return events.some((event) => eventAuthor(event) === null);
}

/** Return all exact associated branch names, using both lane_names and branch. */
export function activityBranchNames(event) {
  const values = [
    ...(Array.isArray(event.lane_names) ? event.lane_names : []),
    event.branch,
  ];
  return Array.from(new Set(values.filter(knownText)));
}

export function activityBranches(events) {
  return Array.from(new Set(events.flatMap(activityBranchNames)))
    .sort((left, right) => left.localeCompare(right));
}

export function hasUnknownBranch(events) {
  return events.some((event) => activityBranchNames(event).length === 0);
}

function encodeFilterValue(prefix, value) {
  if (!knownText(value)) throw new TypeError("filter values must be non-empty strings");
  return `${prefix}${encodeURIComponent(value)}`;
}

export function encodeActivityAuthor(author) {
  return encodeFilterValue(AUTHOR_FILTER_PREFIX, author);
}

export function encodeActivityBranch(branch) {
  return encodeFilterValue(BRANCH_FILTER_PREFIX, branch);
}

function decodeFilterValue(value, prefix) {
  if (typeof value !== "string" || !value.startsWith(prefix)) return { valid: true, value };
  const encoded = value.slice(prefix.length);
  if (encoded.length === 0) return { valid: false, value: null };
  try {
    const decoded = decodeURIComponent(encoded);
    return { valid: knownText(decoded), value: decoded };
  } catch {
    return { valid: false, value: null };
  }
}

function activityDateWindow(startDate, endDate) {
  const error = activityDateRangeError(startDate, endDate);
  if (error) return { state: "invalid", startDate, endDate, error };
  const start = parseCalendarDate(startDate);
  const end = parseCalendarDate(endDate);
  if (start === null && end === null) return { state: "all", startDate: null, endDate: null, error: null };
  return { state: "local_calendar", startDate: start, endDate: end, error: null };
}

function matchesDate(event, dateWindow) {
  if (dateWindow.state === "invalid") return false;
  if (dateWindow.state === "all") return true;
  const date = localCalendarDate(event.occurred_at);
  // An active finite date range cannot claim that an unknown event belongs in
  // the range, so unknown and malformed dates are excluded.
  if (date === null) return false;
  if (dateWindow.startDate !== null && date < dateWindow.startDate) return false;
  if (dateWindow.endDate !== null && date > dateWindow.endDate) return false;
  return true;
}

function decodedFilter(value, prefix) {
  return value === null || value === "" ? { active: false, valid: true, value: null } : { active: true, ...decodeFilterValue(value, prefix) };
}

/** Apply the activity-only author, branch, and date conditions explicitly. */
export function filterActivityEvents(events, options) {
  assertExplicitOptions(options);
  const author = decodedFilter(options.authorFilter, AUTHOR_FILTER_PREFIX);
  const branch = decodedFilter(options.branchFilter, BRANCH_FILTER_PREFIX);
  const dateWindow = activityDateWindow(options.startDate, options.endDate);
  if (!author.valid || !branch.valid || dateWindow.state === "invalid") return [];
  return events.filter((event) => {
    if (author.active) {
      if (options.authorFilter === UNKNOWN_AUTHOR_FILTER) {
        if (eventAuthor(event) !== null) return false;
      } else if (eventAuthor(event) !== author.value) {
        return false;
      }
    }
    if (branch.active) {
      const names = activityBranchNames(event);
      if (options.branchFilter === UNKNOWN_BRANCH_FILTER) {
        if (names.length > 0) return false;
      } else if (!names.includes(branch.value)) {
        return false;
      }
    }
    return matchesDate(event, dateWindow);
  });
}

/** Return filter diagnostics needed to explain finite-date exclusions. */
export function filterActivityDetails(events, options) {
  assertExplicitOptions(options);
  const dateWindow = activityDateWindow(options.startDate, options.endDate);
  const records = filterActivityEvents(events, options);
  const unknownDates = events.filter((event) => localCalendarDate(event.occurred_at) === null).length;
  return {
    records,
    filtered: records,
    total: events.length,
    unknownDates,
    dateWindow,
    finiteRangeUnknownDatesExcluded: dateWindow.state === "local_calendar",
  };
}

function displayUnknown(value) {
  return value === null || value === undefined || value === "" ? "unknown" : String(value);
}

function branchValue(event) {
  const names = activityBranchNames(event);
  return names.length ? names.join(" / ") : null;
}

function csvCell(value) {
  const text = displayUnknown(value);
  const safe = /^[\s\uFEFF]*[=+\-@]/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

const ACTIVITY_COLUMNS = ["source", "type", "date", "author", "branch", "subject", "hash"];

function activityRow(event) {
  return [event.source, event.type, event.occurred_at, event.author, branchValue(event), event.subject, event.commit_hash];
}

/** Convert the supplied, already-filtered activity records to safe CSV. */
export function activityCsv(events) {
  return "\uFEFF" + [ACTIVITY_COLUMNS, ...events.map(activityRow)]
    .map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function markdownCell(value) {
  if (value === null || value === undefined || value === "") return "未取得";
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replace(/[\\`*_{}\[\]()!|]/g, "\\$&").replace(/\r\n|\r|\n/g, "<br>");
}

/** Build a lossless Markdown table for every matching record, not just rows on screen. */
export function activityMarkdown(events) {
  const columns = ["source", "type", "date", "author", "branch", "subject", "hash"];
  return [
    "# gitdash アクティビティ", "",
    `一致件数: ${events.length}`, "",
    `| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`,
    ...events.map((event) => `| ${activityRow(event).map(markdownCell).join(" | ")} |`),
  ].join("\n");
}

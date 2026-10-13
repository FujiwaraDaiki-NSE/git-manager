/**
 * Pure data helpers for the merged pull request explorer.
 *
 * The backend attaches merged PRs to branch rows. A PR can therefore appear
 * on more than one row, while branch_rows === null means that coverage is
 * unknown rather than empty.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const PR_RANGES = new Set(["7", "30", "all", "custom"]);

function isEmptyFilter(value) {
  return value === null || value === "";
}

function assertExplicitFilterOptions(options) {
  if (options === null || typeof options !== "object") {
    throw new TypeError("PR filter options must be provided explicitly");
  }
  const required = ["query", "target", "source", "range", "startDate", "endDate", "observedAt"];
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

/** Return the exact YYYY-MM-DD value when it is a real calendar date. */
function parseCalendarDate(value) {
  if (isEmptyFilter(value) || typeof value !== "string") return null;
  const match = CALENDAR_DATE_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return value;
}

/** Explain malformed or reversed inclusive calendar boundaries. */
export function pullRequestDateRangeError(startDate, endDate) {
  if (startDate === undefined || endDate === undefined) {
    throw new TypeError("startDate and endDate must be provided explicitly; use null or an empty string for no filter");
  }
  const start = parseCalendarDate(startDate);
  const end = parseCalendarDate(endDate);
  if (!isEmptyFilter(startDate) && start === null) return "開始日は有効な日付（YYYY-MM-DD）で指定してください。";
  if (!isEmptyFilter(endDate) && end === null) return "終了日は有効な日付（YYYY-MM-DD）で指定してください。";
  if (start !== null && end !== null && start > end) return "開始日は終了日以前の日付にしてください。";
  return null;
}

function pullRequestTimestamp(value) {
  if (typeof value !== "string" || value.length === 0) return NaN;
  // Date.parse silently normalizes some malformed calendar values. Validate the
  // calendar component first so an unknown merge date stays unknown.
  if (parseCalendarDate(value.slice(0, 10)) === null) return NaN;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

/** Convert a merged-at instant to the browser's local inclusive calendar date. */
export function localCalendarDate(value) {
  const timestamp = pullRequestTimestamp(value);
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizePullRequest(value) {
  return {
    number: value.number,
    url: value.url,
    source: value.source,
    target: value.target,
    commit_hash: value.commit_hash,
    merged_at: value.merged_at,
  };
}

function canonicalUrl(value) {
  return value.trim().replace(/\/$/u, "").toLocaleLowerCase();
}

/** Deduplicate records by the backend PR URL and preserve the first record. */
export function dedupePullRequests(records) {
  const seen = new Set();
  const result = [];
  for (const value of records) {
    const record = normalizePullRequest(value);
    const key = canonicalUrl(record.url);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(record);
  }
  return result;
}

/** Flatten project branch rows while keeping null coverage explicit. */
export function collectMergedPullRequests(project) {
  if (project.branch_rows === null) return [];
  const records = project.branch_rows.flatMap((row) => row.pull_requests);
  return dedupePullRequests(records);
}

function queryText(record) {
  return [
    String(record.number),
    `#${record.number}`,
    record.url,
    record.source,
    record.target,
    record.commit_hash,
    record.merged_at,
  ].filter((value) => value !== null && value !== undefined).join(" ").toLocaleLowerCase();
}

function parsePrDate(value) {
  const parsed = pullRequestTimestamp(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Extract the branch portion of a backend target such as owner/repo:main. */
export function targetBranchName(value) {
  if (typeof value !== "string") return "";
  const separator = value.lastIndexOf(":");
  return separator >= 0 ? value.slice(separator + 1) : value;
}

/** Describe a date window anchored to the project snapshot's observed_at. */
function pullRequestDateWindow(range, observedAt, startDate, endDate) {
  const error = pullRequestDateRangeError(startDate, endDate);
  if (error) {
    return { range, state: "invalid", start: null, end: null, startDate, endDate, error };
  }
  if (!PR_RANGES.has(range)) {
    return { range, state: "invalid", start: null, end: null, startDate, endDate, error: "期間の指定を認識できません。" };
  }
  if (range === "custom") {
    const localStart = parseCalendarDate(startDate);
    const localEnd = parseCalendarDate(endDate);
    if (localStart === null && localEnd === null) {
      return { range, state: "all", start: null, end: null, startDate: null, endDate: null, error: null };
    }
    return { range, state: "local_calendar", start: null, end: null, startDate: localStart, endDate: localEnd, error: null };
  }
  if (range === "all") return { range, state: "all", start: null, end: null, startDate: null, endDate: null, error: null };
  if (typeof observedAt !== "number" || !Number.isFinite(observedAt)) {
    return { range, state: "unknown", start: null, end: null, startDate: null, endDate: null, error: null };
  }
  const end = observedAt * 1000;
  return { range, state: "bounded", start: end - Number(range) * DAY_MS, end, startDate: null, endDate: null, error: null };
}

/**
 * Apply search, target, and date filters. The caller supplies one complete
 * options object. Unknown merged dates are retained for all and excluded from
 * a bounded window because their membership cannot be established.
 */
export function filterPullRequests(records, options) {
  assertExplicitFilterOptions(options);
  const query = isEmptyFilter(options.query) ? "" : options.query.trim().toLocaleLowerCase();
  const dateWindow = pullRequestDateWindow(options.range, options.observedAt, options.startDate, options.endDate);
  const target = isEmptyFilter(options.target) ? "all" : options.target;
  const source = isEmptyFilter(options.source) ? "all" : options.source;
  return records.filter((record) => {
    if (query && !queryText(record).includes(query)) return false;
    if (target !== "all" && record.target !== target && targetBranchName(record.target) !== target) return false;
    if (source !== "all" && record.source !== source) return false;
    if (dateWindow.state === "invalid") return false;
    if (dateWindow.state === "bounded") {
      const mergedAt = parsePrDate(record.merged_at);
      return mergedAt !== null && mergedAt >= dateWindow.start && mergedAt <= dateWindow.end;
    }
    if (dateWindow.state === "local_calendar") {
      const mergedDate = localCalendarDate(record.merged_at);
      if (mergedDate === null) return false;
      if (dateWindow.startDate !== null && mergedDate < dateWindow.startDate) return false;
      if (dateWindow.endDate !== null && mergedDate > dateWindow.endDate) return false;
    }
    return true;
  });
}

export function filterPullRequestDetails(records, options) {
  assertExplicitFilterOptions(options);
  const dateWindow = pullRequestDateWindow(options.range, options.observedAt, options.startDate, options.endDate);
  const unknownDates = records.filter((record) => parsePrDate(record.merged_at) === null).length;
  const filtered = filterPullRequests(records, options);
  return {
    records: filtered,
    filtered,
    total: records.length,
    unknownDates,
    dateWindow,
    finiteRangeUnknownDatesExcluded: dateWindow.state === "bounded" || dateWindow.state === "local_calendar",
  };
}

/** Sort without mutating the source. Unknown dates always stay at the end. */
export function sortPullRequests(records, order) {
  return records.map((record, index) => ({ record, index })).sort((left, right) => {
    if (order === "number") {
      if (left.record.number !== right.record.number) return right.record.number - left.record.number;
      return left.index - right.index;
    }
    const leftDate = parsePrDate(left.record.merged_at);
    const rightDate = parsePrDate(right.record.merged_at);
    if (leftDate === null && rightDate !== null) return 1;
    if (rightDate === null && leftDate !== null) return -1;
    if (leftDate !== null && rightDate !== null && leftDate !== rightDate) {
      if (order === "oldest") return leftDate - rightDate;
      if (order === "newest") return rightDate - leftDate;
    }
    return left.index - right.index;
  }).map(({ record }) => record);
}

export function targetOptions(records) {
  return [...new Set(records.map((record) => record.target).filter((value) => typeof value === "string" && value.length > 0))]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/** Return full source identities exactly as supplied by the backend. */
export function sourceOptions(records) {
  return [...new Set(records.map((record) => record.source).filter((value) => typeof value === "string" && value.length > 0))]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/** Validate a PR link without changing the backend value copied or displayed. */
export function validHttpUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? value : null;
  } catch {
    return null;
  }
}

/** Summarize links available for the currently filtered records. */
export function pullRequestUrlDetails(records) {
  const urls = [];
  let invalidCount = 0;
  for (const record of records) {
    const url = validHttpUrl(record.url);
    if (url === null) {
      invalidCount += 1;
    } else {
      urls.push(url);
    }
  }
  return { urls, value: urls.join("\n"), validCount: urls.length, invalidCount };
}

function csvValue(value) {
  if (value === null) return "";
  const text = String(value);
  // Prefix spreadsheet formula starters, including values with leading spaces
  // or tabs, before applying RFC 4180 quoting.
  const protectedText = /^[\t\r ]*[=+\-@]/u.test(text) ? `'${text}` : text;
  return `"${protectedText.replaceAll('"', '""')}"`;
}

const CSV_COLUMNS = ["number", "source", "target", "commit_hash", "merged_at", "url"];

/** Convert the supplied, already-filtered PR list to a safe CSV payload. */
export function pullRequestsToCsv(records) {
  return [
    CSV_COLUMNS.map(csvValue).join(","),
    ...records.map((record) => CSV_COLUMNS.map((column) => csvValue(record[column])).join(",")),
  ].join("\r\n");
}

/** Build the complete pure model used by the React view. */
export function buildPullRequestExplorerData(project, options) {
  if (options === null || typeof options !== "object" || options.sort === undefined) {
    throw new TypeError("query, target, source, range, startDate, endDate, and sort must be provided explicitly");
  }
  const all = collectMergedPullRequests(project);
  const detail = filterPullRequestDetails(all, {
    query: options.query,
    target: options.target,
    source: options.source,
    range: options.range,
    startDate: options.startDate,
    endDate: options.endDate,
    observedAt: project.observed_at,
  });
  const filtered = sortPullRequests(detail.records, options.sort);
  const urlDetails = pullRequestUrlDetails(filtered);
  return {
    ...detail,
    all,
    filtered,
    targetOptions: targetOptions(all),
    sourceOptions: sourceOptions(all),
    urlDetails,
    coverage: project.branch_rows === null ? "unknown" : project.github.status === "available" ? "attached" : "unavailable",
    githubStatus: project.github.status,
  };
}

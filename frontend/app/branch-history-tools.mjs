export const UNKNOWN_AUTHOR_FILTER = "__gitdash_unknown_author__";
export const AUTHOR_FILTER_PREFIX = "__gitdash_author__:";

const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const IMMUTABLE_COMMIT_HASH_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

function isEmptyFilter(value) {
  return value === null || value === undefined || value === "";
}

function assertExplicitHistoryFilters(authorFilter, startDate, endDate) {
  if (authorFilter === undefined || startDate === undefined || endDate === undefined) {
    throw new TypeError("authorFilter, startDate, and endDate must be provided explicitly; use null or an empty string for no filter");
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
export function historyDateRangeError(startDate, endDate) {
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

function historyTimestamp(value) {
  if (typeof value !== "string" || value.length === 0) return NaN;
  // Validate the calendar component before Date.parse so values such as
  // 2026-02-30 are not silently normalized into a different day.
  if (parseCalendarDate(value.slice(0, 10)) === null) return NaN;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

/** Convert a commit instant to the browser's local inclusive calendar date. */
export function localCalendarDate(value) {
  const timestamp = historyTimestamp(value);
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function hasKnownAuthor(value) {
  return typeof value === "string" && value.length > 0;
}

/** Return exact author values and keep missing-author state available to the UI. */
export function historyAuthors(commits) {
  return Array.from(new Set(commits.filter((commit) => hasKnownAuthor(commit.author)).map((commit) => commit.author)))
    .sort((left, right) => left.localeCompare(right));
}

export function hasUnknownAuthor(commits) {
  return commits.some((commit) => !hasKnownAuthor(commit.author));
}

/** Encode a known author for a select value without colliding with the unknown token. */
export function encodeHistoryAuthor(author) {
  if (!hasKnownAuthor(author)) throw new TypeError("author must be a non-empty string");
  return `${AUTHOR_FILTER_PREFIX}${encodeURIComponent(author)}`;
}

function decodedAuthorFilter(authorFilter) {
  if (typeof authorFilter !== "string" || !authorFilter.startsWith(AUTHOR_FILTER_PREFIX)) {
    return { valid: true, value: authorFilter };
  }
  const encoded = authorFilter.slice(AUTHOR_FILTER_PREFIX.length);
  if (encoded.length === 0) return { valid: false, value: null };
  try {
    const value = decodeURIComponent(encoded);
    return { valid: hasKnownAuthor(value), value };
  } catch {
    return { valid: false, value: null };
  }
}

/** Search only loaded commits; never interpret missing metadata as a match. */
export function filterHistory(commits, query, kind, authorFilter, startDate, endDate) {
  assertExplicitHistoryFilters(authorFilter, startDate, endDate);
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const dateError = historyDateRangeError(startDate, endDate);
  if (dateError) return [];
  const start = parseCalendarDate(startDate);
  const end = parseCalendarDate(endDate);
  const dateFilterActive = start !== null || end !== null;
  const authorFilterActive = authorFilter !== undefined && authorFilter !== null && authorFilter !== "";
  const decodedAuthor = authorFilterActive && authorFilter !== UNKNOWN_AUTHOR_FILTER
    ? decodedAuthorFilter(authorFilter)
    : { valid: true, value: null };
  if (authorFilterActive && authorFilter !== UNKNOWN_AUTHOR_FILTER && !decodedAuthor.valid) return [];
  return commits.filter((commit) => {
    // A missing parents field is an unknown kind. It must not be presented as
    // a regular commit just because it is not a merge.
    if (kind === "merge" && commit.isMerge !== true) return false;
    if (kind === "regular" && commit.isMerge !== false) return false;
    if (authorFilterActive) {
      if (authorFilter === UNKNOWN_AUTHOR_FILTER) {
        if (hasKnownAuthor(commit.author)) return false;
      } else if (commit.author !== decodedAuthor.value) {
        return false;
      }
    }
    if (dateFilterActive) {
      // An active calendar filter excludes unknown or malformed commit dates;
      // the boundary cannot claim an unknown instant is inside its range.
      const commitDate = localCalendarDate(commit.date);
      if (commitDate === null) return false;
      if (start !== null && commitDate < start) return false;
      if (end !== null && commitDate > end) return false;
    }
    const text = [commit.hash, commit.subject, commit.author].filter((value) => typeof value === "string").join("\n").toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

export function sortHistory(commits, order) {
  if (order === "git") return [...commits];
  return commits.map((commit, index) => ({ commit, index })).sort((a, b) => {
    const left = historyTimestamp(a.commit.date);
    const right = historyTimestamp(b.commit.date);
    if (!Number.isFinite(left) && !Number.isFinite(right)) return a.index - b.index;
    if (!Number.isFinite(left)) return 1;
    if (!Number.isFinite(right)) return -1;
    return (order === "oldest" ? left - right : right - left) || a.index - b.index;
  }).map(({ commit }) => commit);
}

/** Fetched commit metadata is authoritative only for the selected hash. */
export function commitHeader(event, detail) {
  if (detail !== null && detail.hash === event.commit_hash) {
    return { subject: detail.subject, author: detail.author, date: detail.date };
  }
  return { subject: event.subject, author: event.author, date: event.occurred_at };
}

function csvCell(value) {
  const text = value === null ? "" : String(value);
  const safe = /^[\s]*[=+\-@]/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function historyCsv(commits) {
  return "\uFEFF" + [
    ["hash", "subject", "author", "date", "kind"],
    ...commits.map((commit) => [commit.hash, commit.subject, commit.author, commit.date, commit.isMerge === true ? "merge" : commit.isMerge === false ? "commit" : "unknown"]),
  ].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

/** Copy all full hashes currently represented by the loaded, filtered rows. */
export function historyHashList(commits) {
  return commits.map((commit) => commit.hash).join("\n");
}

/** POSIX shell single-quote escaping for a literal argument. */
export function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Build a read-only log command from the selected immutable history heads. */
export function historyLogCommand(path, heads) {
  if (typeof path !== "string" || path.length === 0) return null;
  if (!Array.isArray(heads) || heads.length === 0) return null;
  if (!heads.every((head) => typeof head === "string" && IMMUTABLE_COMMIT_HASH_PATTERN.test(head))) return null;
  return `git -C ${shellQuote(path)} log --date-order ${heads.map((head) => shellQuote(head)).join(" ")}`;
}

/**
 * Identify the immutable history snapshot a page request belongs to.
 *
 * The cursor is deliberately excluded: it advances as pages are loaded, while
 * the branch/project/heads/seed data define whether a response is still valid.
 */
export function historyRequestKey(path, rowId, heads, seedHashes) {
  return JSON.stringify([path, rowId, heads, seedHashes]);
}

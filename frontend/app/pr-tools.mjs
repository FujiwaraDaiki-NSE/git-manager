/**
 * Pure data helpers for the merged pull request explorer.
 *
 * The backend attaches merged PRs to branch rows. A PR can therefore appear
 * on more than one row, while branch_rows === null means that coverage is
 * unknown rather than empty.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

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
  ].filter((value) => value !== null).join(" ").toLocaleLowerCase();
}

function parsePrDate(value) {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Extract the branch portion of a backend target such as owner/repo:main. */
export function targetBranchName(value) {
  const separator = value.lastIndexOf(":");
  return separator >= 0 ? value.slice(separator + 1) : value;
}

/** Describe a date window anchored to the project snapshot's observed_at. */
function pullRequestDateWindow(range, observedAt) {
  if (range === "all") return { range, state: "all", start: null, end: null };
  if (range !== "7" && range !== "30") return { range, state: "unknown", start: null, end: null };
  if (typeof observedAt !== "number" || !Number.isFinite(observedAt)) {
    return { range, state: "unknown", start: null, end: null };
  }
  const end = observedAt * 1000;
  return { range, state: "bounded", start: end - Number(range) * DAY_MS, end };
}

/**
 * Apply search, target, and date filters. The caller supplies one complete
 * options object. Unknown merged dates are retained for all and excluded from
 * a bounded window because their membership cannot be established.
 */
export function filterPullRequests(records, options) {
  const query = options.query.trim().toLocaleLowerCase();
  const dateWindow = pullRequestDateWindow(options.range, options.observedAt);
  return records.filter((record) => {
    if (query && !queryText(record).includes(query)) return false;
    if (options.target !== "all" && record.target !== options.target && targetBranchName(record.target) !== options.target) return false;
    if (dateWindow.state !== "bounded") return true;
    const mergedAt = parsePrDate(record.merged_at);
    return mergedAt !== null && mergedAt >= dateWindow.start && mergedAt <= dateWindow.end;
  });
}

export function filterPullRequestDetails(records, options) {
  const dateWindow = pullRequestDateWindow(options.range, options.observedAt);
  const unknownDates = records.filter((record) => parsePrDate(record.merged_at) === null).length;
  const filtered = filterPullRequests(records, options);
  return {
    records: filtered,
    filtered,
    total: records.length,
    unknownDates,
    dateWindow,
    finiteRangeUnknownDatesExcluded: dateWindow.state === "bounded" && options.range !== "all",
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
  return [...new Set(records.map((record) => record.target))]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
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
  const all = collectMergedPullRequests(project);
  const detail = filterPullRequestDetails(all, {
    query: options.query,
    target: options.target,
    range: options.range,
    observedAt: project.observed_at,
  });
  return {
    ...detail,
    all,
    filtered: sortPullRequests(detail.records, options.sort),
    targetOptions: targetOptions(all),
    coverage: project.branch_rows === null ? "unknown" : project.github.status === "available" ? "attached" : "unavailable",
    githubStatus: project.github.status,
  };
}

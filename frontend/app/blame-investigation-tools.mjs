import { filterBlameLines } from "./blame-explorer-tools.mjs";

export const BLAME_LINE_ORDER_CURRENT = "current-ascending";
export const BLAME_LINE_ORDER_ORIGINAL = "original-ascending";
export const BLAME_LINE_ORDER_NEWEST = "newest";
export const BLAME_LINE_ORDER_OLDEST = "oldest";
export const BLAME_LINE_ORDER_VALUES = Object.freeze([
  BLAME_LINE_ORDER_CURRENT,
  BLAME_LINE_ORDER_ORIGINAL,
  BLAME_LINE_ORDER_NEWEST,
  BLAME_LINE_ORDER_OLDEST,
]);

function assertLines(lines) {
  if (!Array.isArray(lines)) throw new TypeError("lines must be an array");
  return lines;
}

function assertString(value, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be provided explicitly`);
  return value;
}

function explicitText(value, label) {
  if (value === null) return "";
  return assertString(value, label);
}

/** Parse one optional positive line bound without accepting coercion or fallback values. */
export function parseBlameLineBound(value, label) {
  if (value === null || value === "") return null;
  assertString(value, label);
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${label}は空欄、または1以上の整数で指定してください。`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label}が大きすぎます。`);
  return number;
}

/** Parse the optional fetched-line subset. Empty bounds deliberately mean unbounded. */
export function resolveBlameLineSubset(start, end) {
  const resolvedStart = parseBlameLineBound(start, "表示開始行");
  const resolvedEnd = parseBlameLineBound(end, "表示終了行");
  if (resolvedStart !== null && resolvedEnd !== null && resolvedEnd < resolvedStart) {
    throw new Error("表示終了行は表示開始行以上で指定してください。");
  }
  return { start: resolvedStart, end: resolvedEnd };
}

function localMidnight(year, month, day) {
  const date = new Date(0);
  date.setHours(0, 0, 0, 0);
  date.setFullYear(year, month - 1, day);
  return date;
}

/** Parse a local-calendar date and return its Unix-second boundaries. */
export function parseBlameCalendarDate(value, label) {
  if (value === null || value === "") return null;
  assertString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error(`${label}はYYYY-MM-DD形式で指定してください。`);
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = localMidnight(year, month, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error(`${label}は実在する日付で指定してください。`);
  }
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + 1);
  const start = date.getTime() / 1000;
  const endExclusive = next.getTime() / 1000;
  if (![start, endExclusive].every((timestamp) => Number.isSafeInteger(timestamp))) {
    throw new Error(`${label}のUnix時刻を安全に扱えません。`);
  }
  return { value, start, endExclusive };
}

/** Resolve inclusive calendar dates into Unix-second filtering boundaries. */
export function resolveBlameDateRange(from, to) {
  const resolvedFrom = parseBlameCalendarDate(from, "コミット日時の開始日");
  const resolvedTo = parseBlameCalendarDate(to, "コミット日時の終了日");
  if (resolvedFrom !== null && resolvedTo !== null && resolvedTo.start < resolvedFrom.start) {
    throw new Error("コミット日時の終了日は開始日以降で指定してください。");
  }
  return {
    from: resolvedFrom === null ? null : resolvedFrom.start,
    toExclusive: resolvedTo === null ? null : resolvedTo.endExclusive,
  };
}

/** Apply every local filter to the already fetched attribution rows. */
export function filterBlameInvestigationLines(lines, options) {
  assertLines(lines);
  if (!options || typeof options !== "object") throw new TypeError("filter options must be provided explicitly");
  const { query, authorFilter, commitFilter, dateFrom, dateTo, subsetStart, subsetEnd } = options;
  const explicitQuery = explicitText(query, "query");
  const explicitAuthorFilter = explicitText(authorFilter, "authorFilter");
  const explicitCommitFilter = explicitText(commitFilter, "commitFilter");
  const explicitDateFrom = explicitText(dateFrom, "dateFrom");
  const explicitDateTo = explicitText(dateTo, "dateTo");
  const explicitSubsetStart = explicitText(subsetStart, "subsetStart");
  const explicitSubsetEnd = explicitText(subsetEnd, "subsetEnd");
  const dateRange = resolveBlameDateRange(explicitDateFrom, explicitDateTo);
  const lineSubset = resolveBlameLineSubset(explicitSubsetStart, explicitSubsetEnd);
  return filterBlameLines(lines, explicitQuery, explicitAuthorFilter, explicitCommitFilter).filter((line) => {
    if (dateRange.from !== null && (typeof line.time !== "number" || !Number.isFinite(line.time) || line.time < dateRange.from)) return false;
    if (dateRange.toExclusive !== null && (typeof line.time !== "number" || !Number.isFinite(line.time) || line.time >= dateRange.toExclusive)) return false;
    if (lineSubset.start !== null && (typeof line.final_line !== "number" || line.final_line < lineSubset.start)) return false;
    if (lineSubset.end !== null && (typeof line.final_line !== "number" || line.final_line > lineSubset.end)) return false;
    return true;
  });
}

function assertOrder(order) {
  assertString(order, "order");
  if (!BLAME_LINE_ORDER_VALUES.includes(order)) throw new Error("行の並び順を選択してください。");
  return order;
}

/** Sort rows with an explicit mode and an index tie-breaker for stable output. */
export function orderBlameLines(lines, order) {
  assertLines(lines);
  const resolvedOrder = assertOrder(order);
  return lines.map((line, index) => ({ line, index })).sort((left, right) => {
    let difference = 0;
    if (resolvedOrder === "current-ascending") difference = left.line.final_line - right.line.final_line;
    if (resolvedOrder === "original-ascending") difference = left.line.original_line - right.line.original_line;
    if (resolvedOrder === "newest" || resolvedOrder === "oldest") {
      if (typeof left.line.time !== "number" || !Number.isFinite(left.line.time) || typeof right.line.time !== "number" || !Number.isFinite(right.line.time)) {
        throw new TypeError("日時の並び替えには有限なUnix時刻が必要です。");
      }
      difference = resolvedOrder === "newest" ? right.line.time - left.line.time : left.line.time - right.line.time;
    }
    return difference === 0 ? left.index - right.index : difference;
  }).map(({ line }) => line);
}

/** Return each distinct commit in the current visible order. */
export function visibleBlameCommitHashes(lines) {
  assertLines(lines);
  const seen = new Set();
  const result = [];
  for (const line of lines) {
    if (typeof line.commit !== "string" || line.commit === "") throw new TypeError("each visible line must have a commit");
    if (seen.has(line.commit)) continue;
    seen.add(line.commit);
    result.push(line.commit);
  }
  return result;
}

/** Summarize the visible rows by commit, retaining first-seen order for ties. */
export function blameCommitSummary(lines) {
  assertLines(lines);
  const counts = new Map();
  for (const line of lines) {
    if (typeof line.commit !== "string" || line.commit === "") throw new TypeError("each visible line must have a commit");
    const previous = counts.get(line.commit);
    counts.set(line.commit, previous === undefined ? 1 : previous + 1);
  }
  const total = lines.length;
  return Array.from(counts, ([commit, lineCount]) => ({
    commit,
    lineCount,
    percent: total === 0 ? 0 : (lineCount / total) * 100,
  })).sort((left, right) => right.lineCount - left.lineCount);
}

/** Join exact line content in displayed order, inserting one boundary LF between rows. */
export function blameRawLineContent(lines) {
  assertLines(lines);
  return lines.map((line) => {
    if (typeof line.content !== "string") throw new TypeError("each visible line must have string content");
    return line.content;
  }).join("\n");
}

/** Detect omitted or repeated line boundaries in the current displayed order. */
export function blameRawLineContentIsNonContiguous(lines) {
  assertLines(lines);
  for (let index = 1; index < lines.length; index += 1) {
    const previous = lines[index - 1].final_line;
    const current = lines[index].final_line;
    if (typeof previous !== "number" || typeof current !== "number" || Math.abs(current - previous) !== 1) return true;
  }
  return false;
}

function assertRequestedRange(range) {
  if (!range || typeof range !== "object") throw new TypeError("requested_range must be provided explicitly");
  if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 1 || range.end < range.start) {
    throw new TypeError("requested_range must contain a valid range");
  }
}

/** Serialize filtered rows with enough immutable investigation context to reproduce the view. */
export function blameJson(lines, metadata) {
  assertLines(lines);
  if (!metadata || typeof metadata !== "object") throw new TypeError("JSON metadata must be provided explicitly");
  const { repo, revision, pinned_hash, file, requested_range, filters } = metadata;
  assertString(repo, "repo");
  assertString(revision, "revision");
  if (pinned_hash !== null && typeof pinned_hash !== "string") throw new TypeError("pinned_hash must be a string or null");
  assertString(file, "file");
  assertRequestedRange(requested_range);
  if (!filters || typeof filters !== "object") throw new TypeError("filters must be provided explicitly");
  return `${JSON.stringify({ repo, revision, pinned_hash, file, requested_range, filters, lines }, null, 2)}\n`;
}


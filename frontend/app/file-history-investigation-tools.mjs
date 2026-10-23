import { filterFileHistory } from "./file-history-tools.mjs";

/** Pure view helpers for the already retrieved file-history snapshot. */

export const FILE_HISTORY_ORDER_GIT = "git";
export const FILE_HISTORY_ORDER_NEWEST = "newest";
export const FILE_HISTORY_ORDER_OLDEST = "oldest";
export const FILE_HISTORY_ORDER_SUBJECT = "subject";
export const FILE_HISTORY_ORDERS = Object.freeze([
  FILE_HISTORY_ORDER_GIT,
  FILE_HISTORY_ORDER_NEWEST,
  FILE_HISTORY_ORDER_OLDEST,
  FILE_HISTORY_ORDER_SUBJECT,
]);

export const FILE_HISTORY_CHANGE_ALL = "all";
export const FILE_HISTORY_CHANGE_UNKNOWN = "unknown";
export const FILE_HISTORY_CHANGE_KINDS = Object.freeze(["A", "M", "D", "R", "C", "T", "U", "X", "B"]);

export const FILE_HISTORY_TOPOLOGY_ALL = "all";
export const FILE_HISTORY_TOPOLOGY_MERGE = "merge";
export const FILE_HISTORY_TOPOLOGY_NON_MERGE = "nonmerge";
export const FILE_HISTORY_TOPOLOGIES = Object.freeze([
  FILE_HISTORY_TOPOLOGY_ALL,
  FILE_HISTORY_TOPOLOGY_MERGE,
  FILE_HISTORY_TOPOLOGY_NON_MERGE,
]);

const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

function assertRecords(records) {
  if (!Array.isArray(records)) throw new TypeError("records must be an array");
}

function isEmpty(value) {
  return value === null || value === undefined || value === "";
}

function daysInMonth(year, month) {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Return an exact YYYY-MM-DD value when it is a real calendar date. */
export function parseFileHistoryCalendarDate(value) {
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
export function fileHistoryDateRangeError(startDate, endDate) {
  if (startDate === undefined || endDate === undefined) {
    throw new TypeError("startDate and endDate must be provided explicitly; use null or an empty string for no filter");
  }
  const start = parseFileHistoryCalendarDate(startDate);
  const end = parseFileHistoryCalendarDate(endDate);
  if (!isEmpty(startDate) && start === null) return "開始日は有効な日付（YYYY-MM-DD）で指定してください。";
  if (!isEmpty(endDate) && end === null) return "終了日は有効な日付（YYYY-MM-DD）で指定してください。";
  if (start !== null && end !== null && start > end) return "開始日は終了日以前の日付にしてください。";
  return null;
}

function historyTimestamp(value) {
  if (typeof value !== "string" || value.length === 0) return NaN;
  // Date.parse normalizes some invalid dates. Validate the source calendar
  // component first so an unknown commit cannot move into the range/order.
  if (parseFileHistoryCalendarDate(value.slice(0, 10)) === null) return NaN;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

/** Convert a commit instant into the browser's local inclusive calendar date. */
export function localFileHistoryCalendarDate(value) {
  const timestamp = historyTimestamp(value);
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function assertFilterOptions(options) {
  if (options === null || typeof options !== "object") {
    throw new TypeError("file-history filter options must be provided explicitly");
  }
  const required = ["query", "authorFilter", "startDate", "endDate", "changeKind", "topology"];
  if (required.some((key) => options[key] === undefined)) {
    throw new TypeError(`${required.join(", ")} must be provided explicitly; use null or an empty string for no filter`);
  }
  if (typeof options.query !== "string") throw new TypeError("query must be a string; use an empty string for no filter");
  if (options.authorFilter !== null && typeof options.authorFilter !== "string") {
    throw new TypeError("authorFilter must be a string or null; use an empty string for no filter");
  }
}

function isKnownChangeKind(value) {
  return value === FILE_HISTORY_CHANGE_ALL
    || value === FILE_HISTORY_CHANGE_UNKNOWN
    || FILE_HISTORY_CHANGE_KINDS.includes(value);
}

function isKnownTopology(value) {
  return FILE_HISTORY_TOPOLOGIES.includes(value);
}

/** Return the leading Git name-status kind, such as R for R100. */
export function fileHistoryChangeKind(record) {
  const status = record?.status;
  return typeof status === "string" && status.length > 0 ? status.slice(0, 1) : null;
}

/** Return merge, nonmerge, or unknown from the explicit parent list. */
export function fileHistoryTopology(record) {
  if (!Array.isArray(record?.parents)) return "unknown";
  return record.parents.length > 1 ? FILE_HISTORY_TOPOLOGY_MERGE : FILE_HISTORY_TOPOLOGY_NON_MERGE;
}

function matchesDate(record, startDate, endDate) {
  const start = parseFileHistoryCalendarDate(startDate);
  const end = parseFileHistoryCalendarDate(endDate);
  if (start === null && end === null) return true;
  const date = localFileHistoryCalendarDate(record?.date);
  // A finite range cannot claim that an unknown or malformed instant belongs
  // to it, so those rows are excluded while an unbounded view keeps them.
  if (date === null) return false;
  if (start !== null && date < start) return false;
  if (end !== null && date > end) return false;
  return true;
}

function matchesChangeKind(record, selected) {
  if (selected === null || selected === "" || selected === FILE_HISTORY_CHANGE_ALL) return true;
  const kind = fileHistoryChangeKind(record);
  return selected === FILE_HISTORY_CHANGE_UNKNOWN ? kind === null : kind === selected;
}

function matchesTopology(record, selected) {
  if (selected === null || selected === "" || selected === FILE_HISTORY_TOPOLOGY_ALL) return true;
  return fileHistoryTopology(record) === selected;
}

/** Apply all local file-history conditions to the supplied loaded records. */
export function filterFileHistoryInvestigation(records, options) {
  assertRecords(records);
  assertFilterOptions(options);
  const dateError = fileHistoryDateRangeError(options.startDate, options.endDate);
  if (dateError || !isKnownChangeKind(options.changeKind) || !isKnownTopology(options.topology)) return [];
  const searched = filterFileHistory(records, options.query, options.authorFilter);
  return searched.filter((record) => (
    matchesDate(record, options.startDate, options.endDate)
    && matchesChangeKind(record, options.changeKind)
    && matchesTopology(record, options.topology)
  ));
}

function knownSubject(value) {
  return typeof value === "string" && value.length > 0;
}

/** Sort without mutating the Git order; unknown values remain at the end. */
export function sortFileHistory(records, order) {
  assertRecords(records);
  if (!FILE_HISTORY_ORDERS.includes(order)) throw new RangeError(`Unknown file-history order: ${order}`);
  if (order === FILE_HISTORY_ORDER_GIT) return [...records];
  return records.map((record, index) => ({ record, index })).sort((left, right) => {
    if (order === FILE_HISTORY_ORDER_SUBJECT) {
      const leftKnown = knownSubject(left.record?.subject);
      const rightKnown = knownSubject(right.record?.subject);
      if (!leftKnown && rightKnown) return 1;
      if (leftKnown && !rightKnown) return -1;
      if (leftKnown && rightKnown) {
        const result = left.record.subject.localeCompare(right.record.subject, undefined, { sensitivity: "base" });
        if (result !== 0) return result;
      }
      return left.index - right.index;
    }
    const leftDate = historyTimestamp(left.record?.date);
    const rightDate = historyTimestamp(right.record?.date);
    if (!Number.isFinite(leftDate) && Number.isFinite(rightDate)) return 1;
    if (Number.isFinite(leftDate) && !Number.isFinite(rightDate)) return -1;
    if (Number.isFinite(leftDate) && Number.isFinite(rightDate) && leftDate !== rightDate) {
      return order === FILE_HISTORY_ORDER_OLDEST ? leftDate - rightDate : rightDate - leftDate;
    }
    return left.index - right.index;
  }).map(({ record }) => record);
}

/** Return adjacent rows in the supplied visible order; never wrap or infer. */
export function adjacentFileHistory(records, selectedHash) {
  assertRecords(records);
  if (selectedHash === undefined) throw new TypeError("selectedHash must be provided explicitly; use null for no selection");
  if (selectedHash !== null && typeof selectedHash !== "string") throw new TypeError("selectedHash must be a string or null");
  const index = selectedHash === null ? -1 : records.findIndex((record) => record?.hash === selectedHash);
  return {
    index,
    count: records.length,
    previous: index > 0 ? records[index - 1] : null,
    next: index >= 0 && index + 1 < records.length ? records[index + 1] : null,
  };
}

function assertExportMetadata(metadata) {
  if (metadata === null || typeof metadata !== "object") throw new TypeError("file-history export metadata must be provided explicitly");
  if (typeof metadata.revision !== "string" || metadata.revision.length === 0) throw new TypeError("revision must be a non-empty string");
  if (typeof metadata.pinnedHash !== "string" || metadata.pinnedHash.length === 0) throw new TypeError("pinnedHash must be a non-empty string");
  if (typeof metadata.file !== "string" || metadata.file.length === 0) throw new TypeError("file must be a non-empty string");
  if (typeof metadata.follow !== "boolean") throw new TypeError("follow must be provided explicitly");
}

/** Serialize exactly the filtered rows with the immutable page metadata. */
export function fileHistoryJson(records, metadata) {
  assertRecords(records);
  assertExportMetadata(metadata);
  return `${JSON.stringify({
    revision: metadata.revision,
    pinned_hash: metadata.pinnedHash,
    file: metadata.file,
    follow: metadata.follow,
    count: records.length,
    commits: records,
  }, null, 2)}\n`;
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

function reportFence(value) {
  const runs = String(value ?? "").match(/`+/g) ?? [];
  const length = Math.max(3, ...runs.map((run) => run.length + 1));
  return "`".repeat(length);
}

function reportFileRow(file) {
  return [
    markdownValue(file?.old_path),
    markdownValue(file?.path),
    file?.additions === undefined || file?.additions === null ? "未取得" : markdownExactValue(file.additions),
    file?.deletions === undefined || file?.deletions === null ? "未取得" : markdownExactValue(file.deletions),
    file?.binary === true ? "true" : file?.binary === false ? "false" : "不明",
  ];
}

/** Build a selected-commit handoff report from explicit summary/detail data. */
export function fileHistoryCommitMarkdown(detail, context) {
  if (detail === null || typeof detail !== "object") throw new TypeError("commit detail must be provided explicitly");
  if (context === null || typeof context !== "object") throw new TypeError("commit report context must be provided explicitly");
  const required = ["repositoryPath", "file", "record", "revision", "pinnedHash", "follow"];
  if (required.some((key) => context[key] === undefined)) {
    throw new TypeError(`${required.join(", ")} must be provided explicitly`);
  }
  if (typeof context.repositoryPath !== "string" || context.repositoryPath.length === 0) throw new TypeError("repositoryPath must be a non-empty string");
  if (typeof context.file !== "string" || context.file.length === 0) throw new TypeError("file must be a non-empty string");
  if (context.record === null || typeof context.record !== "object") throw new TypeError("record must be provided explicitly");
  if (typeof context.revision !== "string" || context.revision.length === 0) throw new TypeError("revision must be a non-empty string");
  if (typeof context.pinnedHash !== "string" || context.pinnedHash.length === 0) throw new TypeError("pinnedHash must be a non-empty string");
  if (typeof context.follow !== "boolean") throw new TypeError("follow must be provided explicitly");
  if (typeof detail.hash !== "string" || detail.hash.length === 0) throw new TypeError("detail.hash must be a non-empty string");
  if (typeof detail.subject !== "string") throw new TypeError("detail.subject must be provided explicitly");
  if (typeof detail.author !== "string") throw new TypeError("detail.author must be provided explicitly");
  if (typeof detail.date !== "string") throw new TypeError("detail.date must be provided explicitly");
  if (!Array.isArray(detail.parents)) throw new TypeError("detail.parents must be an array");
  if (!Array.isArray(detail.files)) throw new TypeError("detail.files must be an array");
  if (typeof detail.patch !== "string") throw new TypeError("detail.patch must be provided explicitly");
  if (typeof detail.patch_truncated !== "boolean") throw new TypeError("detail.patch_truncated must be provided explicitly");

  const files = detail.files;
  const fileRows = files.length > 0
    ? files.map((file) => `| ${reportFileRow(file).join(" | ")} |`)
    : ["| なし | なし | なし | なし | なし |"];
  const patch = detail.patch;
  const fence = reportFence(patch);
  return [
    "# gitdash file history investigation",
    "",
    "## investigation",
    "",
    `- repository_path: ${markdownValue(context.repositoryPath)}`,
    `- file: ${markdownValue(context.file)}`,
    `- revision: ${markdownValue(context.revision)}`,
    `- pinned_hash: ${markdownExactValue(context.pinnedHash)}`,
    `- follow_renames: ${context.follow ? "true" : "false"}`,
    "",
    "## commit",
    "",
    `- hash: ${markdownExactValue(detail.hash)}`,
    `- subject: ${markdownValue(detail.subject)}`,
    `- author: ${markdownValue(detail.author)}`,
    `- date: ${markdownExactValue(detail.date)}`,
    `- change_kind: ${markdownExactValue(fileHistoryChangeKind(context.record))}`,
    `- topology: ${markdownExactValue(fileHistoryTopology(context.record))}`,
    `- parent_count: ${detail.parents.length}`,
    "",
    "## changed files",
    "",
    "| old_path | path | additions | deletions | binary |",
    "| --- | --- | --- | --- | --- |",
    ...fileRows,
    "",
    "## patch",
    "",
    `${fence}diff`,
    patch,
    fence,
    "",
    `- patch_truncated: ${detail.patch_truncated ? "true" : "false"}`,
    "- read_only: true",
  ].join("\n");
}

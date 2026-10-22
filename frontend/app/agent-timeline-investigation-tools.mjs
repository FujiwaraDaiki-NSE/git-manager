import {
  agentStateLabel,
  agentTaskState,
  compareAgentEvents,
  isExplicitAgentStatus,
} from "./agent-overview.mjs";

/**
 * Pure filters and exports for the cross-project agent timeline.
 *
 * The input arrays are already-loaded snapshots. These helpers never fetch,
 * infer a current state from history, or replace an unknown value with a
 * guessed one. `null` and an empty string are explicit empty filters; omitted
 * filter fields are rejected so callers cannot accidentally broaden a query.
 */

export const TIMELINE_STATUS_ALL = "all";
export const TIMELINE_STATUS_UNKNOWN = "unknown";
export const TIMELINE_KIND_ALL = "all";
export const TIMELINE_KIND_STATUS = "status";
export const TIMELINE_KIND_LIFECYCLE = "lifecycle";
export const TIMELINE_SORT_NEWEST = "newest";
export const TIMELINE_SORT_OLDEST = "oldest";

export const TIMELINE_STATUS_VALUES = [
  "investigating",
  "implementing",
  "testing",
  "reviewing",
  "waiting_for_user",
  "blocked",
  "review_required",
  "merge_ready",
  "completed",
  "stopped",
];

const TIMELINE_STATUS_SET = new Set(TIMELINE_STATUS_VALUES);
const TIMELINE_KIND_SET = new Set([
  TIMELINE_KIND_ALL,
  TIMELINE_KIND_STATUS,
  TIMELINE_KIND_LIFECYCLE,
]);
const TIMELINE_SORT_SET = new Set([TIMELINE_SORT_NEWEST, TIMELINE_SORT_OLDEST]);
const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

function isEmpty(value) {
  return value === null || value === undefined || value === "";
}

function assertArray(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
}

function assertOptions(options) {
  if (options === null || typeof options !== "object") {
    throw new TypeError("timeline filter options must be provided explicitly");
  }
  const required = ["query", "projectId", "status", "kind", "startDate", "endDate", "sort"];
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

/** Return a real YYYY-MM-DD value, or null for an empty/malformed value. */
export function parseTimelineCalendarDate(value) {
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
export function timelineDateRangeError(startDate, endDate) {
  if (startDate === undefined || endDate === undefined) {
    throw new TypeError("startDate and endDate must be provided explicitly; use null or an empty string for no filter");
  }
  const start = parseTimelineCalendarDate(startDate);
  const end = parseTimelineCalendarDate(endDate);
  if (!isEmpty(startDate) && start === null) return "開始日は有効な日付（YYYY-MM-DD）で指定してください。";
  if (!isEmpty(endDate) && end === null) return "終了日は有効な日付（YYYY-MM-DD）で指定してください。";
  if (start !== null && end !== null && start > end) return "開始日は終了日以前の日付にしてください。";
  return null;
}

function timelineTimestamp(value) {
  if (typeof value !== "string" || value.length === 0) return NaN;
  // Check the calendar component first. Date.parse accepts some invalid dates
  // by normalizing them, which would turn an unknown event into a false match.
  if (parseTimelineCalendarDate(value.slice(0, 10)) === null) return NaN;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

/** Convert an ISO instant into the browser's local inclusive calendar date. */
export function localTimelineCalendarDate(value) {
  const timestamp = timelineTimestamp(value);
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function timelineDateWindow(startDate, endDate) {
  const error = timelineDateRangeError(startDate, endDate);
  if (error) return { state: "invalid", startDate, endDate, error };
  const start = parseTimelineCalendarDate(startDate);
  const end = parseTimelineCalendarDate(endDate);
  if (start === null && end === null) return { state: "all", startDate: null, endDate: null, error: null };
  return { state: "local_calendar", startDate: start, endDate: end, error: null };
}

function valueText(value) {
  return typeof value === "string" ? value : "";
}

function projectIdForCurrentRow(row) {
  const taskProject = row?.task?.project_id;
  if (typeof taskProject === "string" && taskProject.length > 0) return taskProject;
  return typeof row?.project?.id === "string" ? row.project.id : null;
}

function projectNameForCurrentRow(row) {
  return valueText(row?.project?.name);
}

function timelineSearchTerms(query) {
  const source = query === null ? "" : typeof query === "string" ? query : String(query);
  return source.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
}

function matchesSearch(values, terms) {
  if (terms.length === 0) return true;
  const text = values.filter((value) => typeof value === "string").join("\n").toLocaleLowerCase();
  return terms.every((term) => text.includes(term));
}

function currentRowSearchValues(row) {
  return [
    projectNameForCurrentRow(row),
    projectIdForCurrentRow(row),
    row?.task?.branch,
    row?.task?.summary,
    row?.task?.worktree,
  ];
}

function historySearchValues(event, projectById) {
  const project = typeof event?.project_id === "string" ? projectById.get(event.project_id) : null;
  return [
    project?.name,
    event?.project_id,
    event?.branch,
    event?.summary,
    event?.worktree,
  ];
}

function matchesProject(projectId, selectedProjectId) {
  if (selectedProjectId === null || selectedProjectId === "") return true;
  return projectId === selectedProjectId;
}

function isKnownStatusFilter(value) {
  return value === null || value === "" || value === TIMELINE_STATUS_ALL
    || value === TIMELINE_STATUS_UNKNOWN || TIMELINE_STATUS_SET.has(value);
}

function matchesStatus(item, selectedStatus) {
  if (selectedStatus === null || selectedStatus === "" || selectedStatus === TIMELINE_STATUS_ALL) return true;
  const explicit = isExplicitAgentStatus(item);
  if (selectedStatus === TIMELINE_STATUS_UNKNOWN) return !explicit;
  return explicit && item.status === selectedStatus;
}

function matchesKind(event, selectedKind) {
  if (selectedKind === null || selectedKind === "" || selectedKind === TIMELINE_KIND_ALL) return true;
  return event?.kind === selectedKind;
}

function matchesDate(event, dateWindow) {
  if (dateWindow.state === "invalid" || dateWindow.state === "all") return dateWindow.state === "all";
  const date = localTimelineCalendarDate(event?.occurred_at);
  // A finite range cannot claim that an unknown or malformed timestamp is in it.
  if (date === null) return false;
  if (dateWindow.startDate !== null && date < dateWindow.startDate) return false;
  if (dateWindow.endDate !== null && date > dateWindow.endDate) return false;
  return true;
}

function assertFilterValues(options) {
  if (!isKnownStatusFilter(options.status)) return false;
  if (!TIMELINE_KIND_SET.has(options.kind === null ? TIMELINE_KIND_ALL : options.kind)) return false;
  if (!TIMELINE_SORT_SET.has(options.sort)) return false;
  return true;
}

/** Filter current rows from authoritative project snapshots only. */
export function filterTimelineCurrentRows(rows, options) {
  assertArray(rows, "rows");
  assertOptions(options);
  if (!assertFilterValues(options)) return [];
  const terms = timelineSearchTerms(options.query);
  const projectId = options.projectId === null ? "" : options.projectId;
  return rows.filter((row) => (
    isExplicitAgentStatus(row?.task)
    &&
    matchesProject(projectIdForCurrentRow(row), projectId)
    && matchesStatus(row?.task, options.status)
    && matchesSearch(currentRowSearchValues(row), terms)
  ));
}

/** Filter persisted history without allowing lifecycle rows to create current state. */
export function filterTimelineHistoryEvents(events, options, projectById) {
  assertArray(events, "events");
  assertOptions(options);
  if (!(projectById instanceof Map)) throw new TypeError("projectById must be provided explicitly");
  if (!assertFilterValues(options)) return [];
  const dateWindow = timelineDateWindow(options.startDate, options.endDate);
  if (dateWindow.state === "invalid") return [];
  const terms = timelineSearchTerms(options.query);
  const projectId = options.projectId === null ? "" : options.projectId;
  return events.filter((event) => (
    matchesProject(typeof event?.project_id === "string" ? event.project_id : null, projectId)
    && matchesStatus(event, options.status)
    && matchesKind(event, options.kind)
    && matchesSearch(historySearchValues(event, projectById), terms)
    && matchesDate(event, dateWindow)
  ));
}

/** Sort only the supplied history snapshot; no new events are requested. */
export function sortTimelineHistory(events, sort) {
  assertArray(events, "events");
  if (!TIMELINE_SORT_SET.has(sort)) throw new TypeError("sort must be newest or oldest");
  return [...events].sort((left, right) => sort === TIMELINE_SORT_NEWEST
    ? compareAgentEvents(right, left)
    : compareAgentEvents(left, right));
}

export function timelineHistoryDetails(events, options, projectById) {
  assertArray(events, "events");
  assertOptions(options);
  if (!(projectById instanceof Map)) throw new TypeError("projectById must be provided explicitly");
  const dateWindow = timelineDateWindow(options.startDate, options.endDate);
  const filtered = filterTimelineHistoryEvents(events, options, projectById);
  return {
    records: events,
    filtered: sortTimelineHistory(filtered, options.sort),
    total: events.length,
    unknownDates: events.filter((event) => localTimelineCalendarDate(event?.occurred_at) === null).length,
    dateWindow,
    finiteRangeUnknownDatesExcluded: dateWindow.state === "local_calendar",
  };
}

function csvText(value) {
  if (value === null || value === undefined || value === "") return "";
  return String(value);
}

function csvCell(value) {
  const text = csvText(value);
  // Protect spreadsheet applications from formula-like values, including
  // cells with leading whitespace or a BOM before the formula marker.
  const safe = /^[\s\uFEFF]*[=+\-@]/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

const TIMELINE_CSV_COLUMNS = [
  "event_id",
  "occurred_at",
  "project_id",
  "branch",
  "worktree",
  "kind",
  "status",
  "run_state",
  "action",
  "summary",
];

function timelineCsvRow(event) {
  return [
    event?.event_id,
    event?.occurred_at,
    event?.project_id,
    event?.branch,
    event?.worktree,
    event?.kind,
    event?.status,
    event?.run_state,
    event?.action,
    event?.summary,
  ];
}

/** Convert exactly the supplied, already-filtered history to formula-safe CSV. */
export function timelineHistoryCsv(events) {
  assertArray(events, "events");
  return "\uFEFF" + [TIMELINE_CSV_COLUMNS, ...events.map(timelineCsvRow)]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n") + "\r\n";
}

/**
 * Filter and sort both halves of one displayed snapshot. Date conditions are
 * deliberately history-only because current state has no historical range.
 */
export function filterTimelineSnapshot(snapshot, options, projectById) {
  if (snapshot === null || typeof snapshot !== "object") throw new TypeError("snapshot must be provided explicitly");
  assertArray(snapshot.currentRows, "snapshot.currentRows");
  assertArray(snapshot.history, "snapshot.history");
  assertOptions(options);
  if (!(projectById instanceof Map)) throw new TypeError("projectById must be provided explicitly");
  return {
    currentRows: filterTimelineCurrentRows(snapshot.currentRows, options),
    history: timelineHistoryDetails(snapshot.history, options, projectById).filtered,
    dateWindow: timelineDateWindow(options.startDate, options.endDate),
  };
}

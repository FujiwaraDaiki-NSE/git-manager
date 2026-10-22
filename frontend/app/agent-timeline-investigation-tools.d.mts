import type { AgentEvent, AgentTask, ProjectResponse, ProjectSummary } from "./types";

export const TIMELINE_STATUS_ALL: "all";
export const TIMELINE_STATUS_UNKNOWN: "unknown";
export const TIMELINE_KIND_ALL: "all";
export const TIMELINE_KIND_STATUS: "status";
export const TIMELINE_KIND_LIFECYCLE: "lifecycle";
export const TIMELINE_SORT_NEWEST: "newest";
export const TIMELINE_SORT_OLDEST: "oldest";
export const TIMELINE_STATUS_VALUES: readonly string[];

export type TimelineFilterOptions = {
  query: string | null;
  projectId: string | null;
  status: string | null;
  kind: "all" | "status" | "lifecycle" | null;
  startDate: string | null;
  endDate: string | null;
  sort: "newest" | "oldest";
};

export type TimelineDateWindow = {
  state: "all" | "local_calendar" | "invalid";
  startDate: string | null;
  endDate: string | null;
  error: string | null;
};

export type TimelineCurrentRow = {
  project: ProjectSummary | ProjectResponse;
  task: AgentTask;
};

export type TimelineHistoryDetails = {
  records: AgentEvent[];
  filtered: AgentEvent[];
  total: number;
  unknownDates: number;
  dateWindow: TimelineDateWindow;
  finiteRangeUnknownDatesExcluded: boolean;
};

export function parseTimelineCalendarDate(value: string | null | undefined): string | null;
export function timelineDateRangeError(startDate: string | null, endDate: string | null): string | null;
export function localTimelineCalendarDate(value: string | null | undefined): string | null;
export function timelineDateWindow(startDate: string | null, endDate: string | null): TimelineDateWindow;
export function filterTimelineCurrentRows(rows: TimelineCurrentRow[], options: TimelineFilterOptions): TimelineCurrentRow[];
export function filterTimelineHistoryEvents(events: AgentEvent[], options: TimelineFilterOptions, projectById: Map<string, ProjectSummary>): AgentEvent[];
export function sortTimelineHistory(events: AgentEvent[], sort: "newest" | "oldest"): AgentEvent[];
export function timelineHistoryDetails(events: AgentEvent[], options: TimelineFilterOptions, projectById: Map<string, ProjectSummary>): TimelineHistoryDetails;
export function timelineHistoryCsv(events: AgentEvent[]): string;
export function filterTimelineSnapshot(snapshot: { currentRows: TimelineCurrentRow[]; history: AgentEvent[] }, options: TimelineFilterOptions, projectById: Map<string, ProjectSummary>): { currentRows: TimelineCurrentRow[]; history: AgentEvent[]; dateWindow: TimelineDateWindow };

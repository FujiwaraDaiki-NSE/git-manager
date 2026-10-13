import type { ProjectEvent } from "./types";

export type ActivityFilterOptions = {
  authorFilter: string | null;
  branchFilter: string | null;
  startDate: string | null;
  endDate: string | null;
};
export type ActivityDateWindow = {
  state: "all" | "local_calendar" | "invalid";
  startDate: string | null;
  endDate: string | null;
  error: string | null;
};
export type ActivityExplorerDetails = {
  records: ProjectEvent[];
  filtered: ProjectEvent[];
  total: number;
  unknownDates: number;
  dateWindow: ActivityDateWindow;
  finiteRangeUnknownDatesExcluded: boolean;
};

export const UNKNOWN_AUTHOR_FILTER: string;
export const AUTHOR_FILTER_PREFIX: string;
export const UNKNOWN_BRANCH_FILTER: string;
export const BRANCH_FILTER_PREFIX: string;

export function activityDateRangeError(startDate: string | null, endDate: string | null): string | null;
export function localCalendarDate(value: string | null | undefined): string | null;
export function activityAuthors(events: ProjectEvent[]): string[];
export function hasUnknownAuthor(events: ProjectEvent[]): boolean;
export function activityBranchNames(event: ProjectEvent): string[];
export function activityBranches(events: ProjectEvent[]): string[];
export function hasUnknownBranch(events: ProjectEvent[]): boolean;
export function encodeActivityAuthor(author: string): string;
export function encodeActivityBranch(branch: string): string;
export function filterActivityEvents(events: ProjectEvent[], options: ActivityFilterOptions): ProjectEvent[];
export function filterActivityDetails(events: ProjectEvent[], options: ActivityFilterOptions): ActivityExplorerDetails;
export function activityCsv(events: ProjectEvent[]): string;
export function activityMarkdown(events: ProjectEvent[]): string;

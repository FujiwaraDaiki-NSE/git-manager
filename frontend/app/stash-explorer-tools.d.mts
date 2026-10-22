export type StashSummary = {
  hash: string;
  selector: string;
  subject: string;
  date: string;
};

export type StashFile = {
  old_path?: string;
  additions: number | "-";
  deletions: number | "-";
  path: string;
  binary: boolean;
};

export type StashPart = {
  available: boolean;
  files: StashFile[];
  patch: string;
  patch_truncated: boolean;
  command: string | null;
};

export type StashDetail = StashSummary & {
  tracked: StashPart;
  untracked: StashPart;
  command: string;
  untracked_command: string | null;
};

export type StashOrder = "git" | "newest" | "oldest" | "subject";

export function parseStashCalendarDate(value: string | null): string | null;
export function stashDateRangeError(startDate: string | null, endDate: string | null): string | null;
export function localStashCalendarDate(value: string | null): string | null;
export function searchStashes(stashes: StashSummary[], query: string): StashSummary[];
export function filterStashes(stashes: StashSummary[], query: string, startDate: string | null, endDate: string | null): StashSummary[];
export function sortStashes(stashes: StashSummary[], order: StashOrder): StashSummary[];
export function stashInventoryCsv(stashes: StashSummary[]): string;
export function stashHashList(stashes: StashSummary[]): string;
export function adjacentStashes(stashes: StashSummary[], selectedHash: string | null): {
  index: number;
  count: number;
  previous: StashSummary | null;
  next: StashSummary | null;
};
export function stashInvestigationMarkdown(detail: StashDetail, path: string): string;
export function stashCommand(path: string, command: string | null | undefined): string | null;
export function stashPartLabel(part: "tracked" | "untracked"): string;

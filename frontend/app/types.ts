export type Entry = { xy: string; path: string };
export type Count = { xy: string; count: number };
export type Commit = { hash: string; subject: string; author: string; date: string };
export type NextCommand = { command: string; reason: string };

export type Repo = {
  path: string;
  name: string;
  pending?: boolean;
  activity?: number;
  error?: string | null;
  branch?: string | null;
  detached?: boolean;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  entries?: Entry[];
  counts?: Count[];
  branch_line?: string;
  stashes?: number;
  remote?: string | null;
  last_commit?: Commit | null;
  next_command?: NextCommand | null;
  can_ff?: boolean;
  diverged?: boolean;
  fetched_at?: number | null;
};

export const isDirty = (r: Repo) => (r.entries?.length ?? 0) > 0;
export const hasConflict = (r: Repo) =>
  (r.entries ?? []).some((e) => ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(e.xy));

export type Entry = { xy: string; path: string };
export type Count = { xy: string; count: number };
export type Commit = { hash: string; subject: string; author: string; date: string };
export type NextCommand = { command: string; reason: string };

export type GraphRefKind = "head" | "branch" | "remote" | "tag";
export type GraphRef = { name: string; kind: GraphRefKind };
export type GraphRow = {
  hash: string;
  short: string;
  parents: string[];
  refs: GraphRef[];
  author: string;
  date: string;
  subject: string;
  lane: number;
  in_lanes: number[];
  through: number[];
  out_lanes: number[];
  is_head: boolean;
  is_merge: boolean;
};
export type GraphResponse = {
  rows: GraphRow[];
  max_lane: number;
  head_lane: number | null;
  truncated: boolean;
  command: string;
};

export type Numstat = {
  additions: number | "-";
  deletions: number | "-";
  path: string;
  binary: boolean;
};
export type CommitDetail = {
  hash: string;
  subject: string;
  author: string;
  date: string;
  parents: string[];
  files: Numstat[];
  patch: string;
  patch_truncated: boolean;
  command: string;
};

export type Branch = {
  name: string;
  hash: string;
  upstream: string | null;
  track: string | null;
  date: string;
  current: boolean;
  merged: boolean;
};
export type BranchesResponse = {
  local: Branch[];
  remotes: Branch[];
  command: string;
};

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

export type Entry = { xy: string; path: string };
export type Count = { xy: string; count: number };
export type Commit = { hash: string; subject: string; author: string; date: string };
export type NextCommand = { command: string; reason: string };

export type GraphRefKind = "head" | "branch" | "remote" | "tag";
export type GraphRef = { name: string; kind: GraphRefKind };
export type BranchHead = { name: string; hash: string };
export type CommitStats = {
  files: number;
  additions: number | null;
  deletions: number | null;
  paths: string[];
};
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
  stats?: CommitStats | null;
};
export type GraphResponse = {
  rows: GraphRow[];
  max_lane: number;
  head_lane: number | null;
  default_branch: string | null;
  default_hash: string | null;
  default_lane: number | null;
  branch_heads: BranchHead[];
  truncated: boolean;
  command: string;
};

export type BranchRelation = {
  names: string[];
  headHash: string;
  headRow: GraphRow;
  commonAncestorHash: string | null;
  commonAncestorRow: GraphRow | null;
  branchPath: GraphRow[] | null;
  defaultPath: GraphRow[] | null;
};

export type BranchRelationSummary = {
  defaultBranch: string | null;
  defaultLane: number | null;
  branches: BranchRelation[];
  rowIndex: Record<string, number>;
  maxLane: number;
  omittedGroups: number;
  omittedBranches: number;
  unavailableReason: string | null;
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
  worktree: string | null;
};
export type BranchesResponse = {
  local: Branch[];
  remotes: Branch[];
  command: string;
};

export type AgentCounts = {
  running: number | null;
  waiting_for_user: number | null;
  problem: number | null;
  reviewing: number | null;
  integratable: number | null;
};

export type ProjectLane = {
  id: string;
  name: string;
  branch: string | null;
  path: string | null;
  is_worktree: boolean;
  worktree_state: "ok" | "prunable" | "locked" | null;
  head: string | null;
  merge_base: string | null;
  default_ahead: number | null;
  default_behind: number | null;
  merged: boolean | null;
  dirty: boolean | null;
  conflict: boolean | null;
  detached: boolean | null;
  upstream: string | null;
  upstream_ahead: number | null;
  upstream_behind: number | null;
  branch_line: string | null;
  last_commit: Commit & { short?: string } | null;
  next_command: NextCommand | null;
  error: string | null;
  agent: {
    task_id?: string | null;
    state?: string | null;
    summary?: string | null;
    occurred_at?: string | null;
  } | null;
  merge_target: string | null;
  next_phase: string | null;
};

export type ProjectWorktree = {
  path: string;
  branch: string | null;
  head: string | null;
  state: "ok" | "prunable" | "locked" | null;
  detached: boolean;
  is_main: boolean;
};

export type ProjectEvent = {
  id: string;
  occurred_at: string | null;
  observed_at: number;
  type: "commit" | "worktree" | "branch" | string;
  source: "git" | "agent" | "review" | "ci" | string;
  project_id: string | null;
  worktree: string | null;
  branch: string | null;
  lane_id: string | null;
  lane_names?: string[];
  commit_hash: string | null;
  subject: string | null;
  author: string | null;
  parents?: string[];
  stats?: CommitStats | null;
};

export type ProjectGitCounts = {
  dirty: number;
  conflict: number;
  ahead: number;
  behind: number;
  merged: number;
  prunable: number;
  locked: number;
};

export type ProjectSummary = {
  id: string;
  name: string;
  remote: string | null;
  main_path: string | null;
  lane_count: number;
  worktree_count: number;
  git: ProjectGitCounts;
  latest_event: Commit | null;
  latest_observed_at: number;
  priority: number;
  next_lane: string | null;
  largest_difference_lane: string | null;
  agent_counts: AgentCounts;
  agent_state: string | null;
};

export type ProjectResponse = {
  id: string;
  name: string;
  description: string | null;
  remote: string | null;
  default_branch: string | null;
  default_hash: string | null;
  main_path: string;
  fetched_at: number | null;
  observed_at: number;
  graph: GraphResponse | null;
  lanes: ProjectLane[];
  events: ProjectEvent[];
  latest_event: ProjectEvent | null;
  branch_counts: { local: number; remote: number };
  worktrees: ProjectWorktree[];
  maintenance: { merged: number; prunable: number; locked: number };
  languages: string[] | null;
  directories: string[] | null;
  test_commands: string[] | null;
  agent_tasks: unknown[] | null;
  agent_counts: AgentCounts;
  ci: unknown | null;
  reviews: unknown | null;
  merge_target: string | null;
};

export type Repo = {
  path: string;
  name: string;
  common_dir: string;
  is_worktree: boolean;
  worktree_state: "ok" | "prunable" | "locked" | null;
  worktree?: string | null;
  merged?: boolean;
  merged_branches?: string[];
  merged_branch?: string | null;
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
  checked_at?: number;
};

export const isDirty = (r: Repo) => (r.entries?.length ?? 0) > 0;
export const hasConflict = (r: Repo) =>
  (r.entries ?? []).some((e) => ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(e.xy));

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
  old_path?: string;
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
  merged: boolean | null;
  worktree: string | null;
};
export type BranchesResponse = {
  local: Branch[];
  remotes: Branch[];
  command: string;
};

/** Explicit branch work status published by the agent status contract. */
export type AgentStatus =
  | "investigating"
  | "implementing"
  | "testing"
  | "reviewing"
  | "waiting_for_user"
  | "blocked"
  | "review_required"
  | "merge_ready"
  | "completed"
  | "stopped"
  | string;

/** Runtime state from hook/lifecycle history. It is not a branch work status. */
export type AgentRunState =
  | "active"
  | "idle"
  | "interrupted"
  | "ended"
  | "stopped"
  | string;

export type AgentEventKind = "lifecycle" | "status" | string;

export type AgentTask = {
  /** Legacy history identity. Branch status reports do not require it. */
  task_id?: string | null;
  agent_id?: string | null;
  project_id?: string | null;
  worktree: string | null;
  branch: string | null;
  kind?: AgentEventKind | null;
  status?: AgentStatus | null;
  run_state: AgentRunState | null;
  phase: string | null;
  attention: string | null;
  outcome: string | null;
  summary: string | null;
  occurred_at: string | null;
};

export type AgentEvent = AgentTask & {
  event_id: string;
  observed_at: number;
  sequence?: number;
};

export type AgentEventEnvelope = {
  event_id: string;
  worktree: string;
  snapshot: AgentEvent;
};

export type AgentCounts = {
  running: number | null;
  waiting_for_user: number | null;
  problem: number | null;
  reviewing: number | null;
  integratable: number | null;
};

export type AgentPriorityCounts = {
  waiting_for_user: number | null;
  blocked: number | null;
  review_required: number | null;
  merge_ready: number | null;
  active: number | null;
  completed: number | null;
};

export type ProjectMergeRelation = {
  kind?: "branch" | "merge" | "commit";
  pr_number?: number | null;
  pr_url?: string | null;
  commit_hash: string;
  occurred_at: string | null;
  target_parent: string;
  source_parent: string;
  source_branch: string | null;
  source_lane_id: string | null;
  target_branch: string | null;
  target_lane_id: string | null;
};

export type ProjectLane = {
  historical?: boolean;
  unborn?: boolean;
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
  agent: AgentTask | null;
  merge_target: string | null;
  merge_sources: ProjectMergeRelation[];
  merge_targets: ProjectMergeRelation[];
  next_phase: string | null;
};

export type ProjectBranchPullRequest = {
  number: number;
  url: string;
  source: string;
  target: string;
  source_repository: string | null;
  source_branch: string;
  source_hash: string | null;
  target_repository: string;
  target_branch: string;
  commit_hash: string | null;
  head_hash: string | null;
  merged_at: string | null;
};

export type ProjectBranchCommit = {
  hash: string;
  short: string;
  subject: string;
  author: string;
  date: string | null;
  parents: string[];
};

/**
 * A display row represents one remote branch, or one local-only branch. Local
 * checkouts are nested in the row that their upstream points to. The commit
 * list is intentionally a reachability view: a commit may occur in more than
 * one row when branches share history.
 */
export type ProjectBranchRow = {
  id: string;
  name: string;
  remote_ref: string | null;
  remote_hash: string | null;
  remote_name: string | null;
  remote_branch: string | null;
  remote_repository: string | null;
  tracking_ref: string | null;
  locals: ProjectLane[];
  commit_hashes: string[];
  commits: ProjectBranchCommit[];
  tip_commits: ProjectBranchCommit[];
  tip_metadata_available: boolean;
  history_heads: string[];
  history_cursor: number | null;
  commit_metadata_available: boolean;
  history_truncated: boolean;
  history_available: boolean;
  historical: boolean;
  status: "synchronized" | "local_ahead" | "remote_ahead" | "diverged" | "remote_only" | "remote_unavailable" | "tracking_unavailable" | "tracking_inconsistent" | "mixed" | "local_only" | "upstream_deleted" | "detached" | "historical_deleted" | string;
  pull_requests: ProjectBranchPullRequest[];
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
  commit_hash?: string | null;
  subject?: string | null;
  author?: string | null;
  parents?: string[];
  stats?: CommitStats | null;
  task_id?: string | null;
  agent_id?: string | null;
  event_id?: string | null;
  sequence?: number | null;
  kind?: AgentEventKind | null;
  status?: AgentStatus | null;
  run_state?: AgentRunState | null;
  phase?: string | null;
  attention?: string | null;
  outcome?: string | null;
  summary?: string | null;
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
  lane_count: number | null;
  worktree_count: number;
  git: ProjectGitCounts;
  latest_event: Commit | null;
  latest_observed_at: number;
  priority: number;
  next_lane: string | null;
  largest_difference_lane: string | null;
  agent_counts: AgentCounts;
  agent_tasks: AgentTask[] | null;
  agent_state: AgentStatus | null;
  agent_priority_counts: AgentPriorityCounts;
  latest_agent_event: AgentEvent | null;
};

export type ProjectResponse = {
  github: { status: "available" | "unavailable" | "not_applicable"; reason: string | null; repository: string | null; checked_at: number | null };
  branch_rows: ProjectBranchRow[] | null;
  id: string;
  name: string;
  description: string | null;
  remote: string | null;
  default_branch: string | null;
  default_hash: string | null;
  main_path: string;
  fetched_at: number | null;
  observed_at: number;
  range: "current" | "24h" | "7d" | "all";
  graph: GraphResponse | null;
  lanes: ProjectLane[];
  merge_relations: ProjectMergeRelation[];
  events: ProjectEvent[];
  latest_event: ProjectEvent | null;
  branch_counts: { local: number; remote: number };
  worktrees: ProjectWorktree[];
  maintenance: { merged: number; prunable: number; locked: number };
  languages: string[] | null;
  directories: string[] | null;
  test_commands: string[] | null;
  agent_tasks: AgentTask[] | null;
  agent_counts: AgentCounts;
  agent_priority_counts: AgentPriorityCounts;
  agent_state: AgentStatus | null;
  agent_latest_event: AgentEvent | null;
  agent_events: AgentEvent[];
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

import { agentTaskState } from './agent-overview.mjs';
import { missingLocalTrackingRefLabel } from './upstream-label.mjs';

// One geometry contract for rows, SVG endpoints and connection chips.
export function timelineRowGeometry(rows, eventsByRow) {
  let top = 0;
  return { rows: rows.map((row) => {
    const compact = row.history_available === true && eventsByRow.has(row.id) === false;
    const height = compact ? 44 : 88;
    const result = { top, height, center: top + height / 2, compact };
    top += height;
    return result;
  }), get height() { return top; } };
}

// Freshness only changes presentation, never the explicit agent status.
export function agentFreshness(occurredAt, now) {
  if (occurredAt === null || now === null) return 'unknown';
  const time = Date.parse(occurredAt);
  if (!Number.isFinite(time)) return 'unknown';
  const age = Math.max(0, now - time);
  return age < 3600000 ? 'fresh' : age < 86400000 ? 'recent' : 'old';
}

export function rowAgentReports(row, tasks) {
  if (tasks === null) return [];
  const branches = new Set(row.locals.map((lane) => lane.branch).filter((branch) => branch !== null));
  return tasks.filter((task) => branches.has(task.branch) && agentTaskState(task) !== null);
}

// Per-branch reachability is authoritative; null means it cannot be judged.
export function isUnpushedCommit(row, hash) {
  return row.locals.some((lane) => lane.upstream !== null && lane.upstream === row.tracking_ref && lane.unpushed_commits !== null && lane.unpushed_commits.includes(hash));
}
export function historicalPullRequestLabel(row) {
  if (!row.historical || row.pull_requests.length === 0) return null;
  const numbers = row.pull_requests.map(({ number }) => `#${number}`).join(", ");
  const repository = row.pull_requests[0].source_repository;
  return `PR ${numbers} · 作成元 ${repository === null ? "不明" : repository}`;
}

export function rowStatus(row) {
  const labels = {
    synchronized: ["同期済み", "lane-state-ok"],
    local_ahead: ["ローカル先行（未push）", "lane-state-warn"],
    remote_ahead: ["リモート先行（未pull）", "lane-state-warn"],
    diverged: ["分岐", "lane-state-danger"],
    remote_only: ["リモートのみ", "lane-state-muted"],
    remote_unavailable: ["リモート参照未取得", "lane-state-warn"],
    tracking_unavailable: ["追跡状態未取得", "lane-state-warn"],
    tracking_inconsistent: ["追跡状態不整合", "lane-state-warn"],
    mixed: ["ローカル混在", "lane-state-warn"],
    local_only: ["ローカルのみ", "lane-state-muted"],
    upstream_deleted: [missingLocalTrackingRefLabel, "lane-state-danger"],
    detached: ["detached HEAD", "lane-state-muted"],
    historical_deleted: ["マージ済みPRの履歴", "lane-state-muted"],
  };
  if (labels[row.status]) return labels[row.status];
  if (row.historical) return ["履歴", "lane-state-muted"];
  return ["状態未取得", "lane-state-muted"];
}

export function branchJumpLabel(row, name, duplicateName) {
  if (!duplicateName) return name;
  const pullRequest = historicalPullRequestLabel(row);
  const label = pullRequest ?? (row.status === "remote_only" ? row.remote_ref : rowStatus(row)[0]);
  return `${name} · ${label}`;
}

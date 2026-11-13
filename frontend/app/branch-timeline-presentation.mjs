import { agentTaskState } from './agent-overview.mjs';

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
  const branches = new Set([row.name, ...row.locals.map((lane) => lane.branch).filter((branch) => branch !== null)]);
  return tasks.filter((task) => branches.has(task.branch) && agentTaskState(task) !== null);
}

// Per-branch reachability is authoritative; null means it cannot be judged.
export function isUnpushedCommit(row, hash) {
  return row.locals.some((lane) => lane.upstream !== null && lane.upstream === row.tracking_ref && lane.unpushed_commits !== null && lane.unpushed_commits.includes(hash));
}

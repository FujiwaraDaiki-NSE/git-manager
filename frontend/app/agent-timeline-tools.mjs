import {
  agentReportKey,
  agentTaskState,
  compareAgentEvents,
  isExplicitAgentStatus,
  mergeAgentSnapshot,
} from "./agent-overview.mjs";

/**
 * Merge the persisted replay and live stream into one identity-stable list.
 * Event IDs are the only history identity; malformed rows are left unknown
 * instead of being given a guessed key.
 */
export function mergeAgentEvents(previous, incoming) {
  const byId = new Map();
  for (const event of [...previous, ...incoming]) {
    if (!event || typeof event.event_id !== "string" || event.event_id.length === 0) continue;
    const current = byId.get(event.event_id);
    if (!current || compareAgentEvents(event, current) >= 0) byId.set(event.event_id, event);
  }
  return [...byId.values()].sort((left, right) => compareAgentEvents(right, left));
}

/**
 * Current attention is projected only from the authoritative project
 * snapshots. Historical events, including lifecycle rows, cannot create a
 * current task. Duplicate project/branch rows are collapsed by their stable
 * project and branch identity.
 */
export function currentAgentTasks(projects) {
  const byKey = new Map();
  for (const project of projects) {
    if (!Array.isArray(project?.agent_tasks)) continue;
    for (const task of project.agent_tasks) {
      if (!isExplicitAgentStatus(task)) continue;
      const key = agentReportKey(task);
      if (!key) continue;
      byKey.set(key, { project, task });
    }
  }
  return [...byKey.values()];
}

export function hasUnknownCurrentTasks(projects) {
  return projects.some((project) => project.agent_tasks === null);
}

export function sortTimelineEvents(events) {
  return [...events].sort((left, right) => compareAgentEvents(right, left));
}

/** Reconcile HTTP replay with live events without regressing newer statuses. */
export function applyBufferedAgentEvents(projects, events) {
  return projects.map((project) => {
    let next = project;
    for (const event of events) {
      if (event.project_id === project.id) next = mergeAgentSnapshot(next, event);
    }
    return next;
  });
}

// Freshness affects presentation only, never the explicit status.
export const AGENT_REPORT_RECENT_MS = 24 * 60 * 60 * 1000;
export const AGENT_DECISION_STATUSES = ["waiting_for_user", "review_required", "merge_ready", "blocked"];
export function agentReportFreshness(occurredAt, now) {
  const time = typeof occurredAt === "string" ? Date.parse(occurredAt) : NaN;
  return !Number.isFinite(time) ? "unknown"
    : now - time >= AGENT_REPORT_RECENT_MS ? "old" : "recent";
}
const progressStatuses = new Set(["investigating", "implementing", "testing", "reviewing"]);
export function classifyCurrentAgentRows(rows, now) {
  const groups = {
    decision: { recent: [], old: [], unknown: [] },
    active: [], finished: [], old: [], unknown: [],
    decisionCounts: Object.fromEntries(AGENT_DECISION_STATUSES.map((status) => [status, 0])),
  };
  for (const row of rows) {
    const status = agentTaskState(row.task);
    const freshness = agentReportFreshness(row.task.occurred_at, now);
    if (AGENT_DECISION_STATUSES.includes(status)) {
      groups.decision[freshness].push(row);
      groups.decisionCounts[status] += 1;
    } else if (freshness !== "recent") groups[freshness].push(row);
    else if (progressStatuses.has(status)) groups.active.push(row);
    else groups.finished.push(row);
  }
  return groups;
}

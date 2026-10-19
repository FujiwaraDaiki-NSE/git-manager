import {
  agentReportKey,
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

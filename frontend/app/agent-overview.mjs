// Pure presentation and projection helpers for agent branch reports.
//
// The backend owns the current status. This module only projects that
// contract into cards, lanes, and historical views. A lifecycle event is
// activity history; it is never a replacement for the latest explicit status
// report of a project branch.

export const AGENT_STATUS_PRIORITY = [
  "waiting_for_user",
  "blocked",
  "review_required",
  "merge_ready",
  "investigating",
  "implementing",
  "testing",
  "reviewing",
  "completed",
  "stopped",
];

// Keep this list for consumers that use the older priority bucket name. The
// first four active statuses are deliberately projected into `active` for
// aggregate counters while their precise labels remain visible per branch.
export const AGENT_STATE_PRIORITY = [
  "waiting_for_user",
  "blocked",
  "review_required",
  "merge_ready",
  "active",
  "completed",
  "stopped",
];

export const AGENT_STATE_LABELS = {
  investigating: "調査中",
  implementing: "実装中",
  testing: "テスト中",
  reviewing: "レビュー中",
  waiting_for_user: "入力待ち",
  blocked: "問題あり",
  review_required: "レビュー待ち",
  merge_ready: "マージ可能",
  completed: "完了",
  stopped: "中断",
};

const priority = new Map(AGENT_STATE_PRIORITY.map((state, index) => [state, index]));
const activeStatuses = new Set(["investigating", "implementing", "testing", "reviewing"]);
const knownStatuses = new Set(AGENT_STATUS_PRIORITY);

export function agentStateLabel(state) {
  return state ? AGENT_STATE_LABELS[state] || state : "ブランチ状態不明";
}

export function agentStatePriority(state) {
  if (activeStatuses.has(state)) return priority.get("active");
  return state && priority.has(state) ? priority.get(state) : AGENT_STATE_PRIORITY.length;
}

/**
 * Return only an explicit branch status. Lifecycle records intentionally do
 * not fall back to run_state, phase, attention, or outcome. Reports without a
 * canonical status marker remain unknown.
 */
export function agentTaskState(task) {
  if (!task) return null;
  if (task.kind === "lifecycle") return null;
  return task.kind === "status" && knownStatuses.has(task.status) ? task.status : null;
}

export function eventTime(value) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

function latestTime(item) {
  return eventTime(item?.occurred_at) ?? 0;
}

/** True for a report that is allowed to change branch state. */
export function isExplicitAgentStatus(item) {
  return Boolean(item && item.kind === "status" && knownStatuses.has(item.status));
}

/** Stable identity for the branch unit represented by a report. */
export function agentReportKey(item) {
  if (!item) return null;
  const project = typeof item.project_id === "string" ? item.project_id : null;
  const branch = typeof item.branch === "string" && item.branch ? item.branch : null;
  return project && branch ? `project:${project}\u001fbranch:${branch}` : null;
}

function sequenceValue(item) {
  return typeof item?.sequence === "number" && Number.isFinite(item.sequence)
    ? item.sequence
    : null;
}

function observedValue(item) {
  return typeof item?.observed_at === "number" && Number.isFinite(item.observed_at)
    ? item.observed_at
    : null;
}

/** Compare the same branch report using the backend's occurred/sequence order. */
export function compareAgentEvents(left, right) {
  const leftTime = eventTime(left?.occurred_at);
  const rightTime = eventTime(right?.occurred_at);
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return leftTime - rightTime;
  if (leftTime !== null && rightTime === null) return 1;
  if (leftTime === null && rightTime !== null) return -1;
  const leftSequence = sequenceValue(left);
  const rightSequence = sequenceValue(right);
  if (leftSequence !== null && rightSequence !== null && leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }
  if (leftSequence !== null && rightSequence === null) return 1;
  if (leftSequence === null && rightSequence !== null) return -1;
  const leftObserved = observedValue(left);
  const rightObserved = observedValue(right);
  if (leftObserved !== null && rightObserved !== null && leftObserved !== rightObserved) {
    return leftObserved - rightObserved;
  }
  if (leftObserved !== null && rightObserved === null) return 1;
  if (leftObserved === null && rightObserved !== null) return -1;
  return String(left?.event_id || "").localeCompare(String(right?.event_id || ""));
}

export function isNewerAgentEvent(next, current) {
  if (!current) return true;
  return compareAgentEvents(next, current) > 0;
}

export function topAgentTasks(tasks, limit = 3) {
  return [...(tasks || [])]
    .filter((task) => Boolean(task))
    .sort((a, b) => {
      const byState = agentStatePriority(agentTaskState(a)) - agentStatePriority(agentTaskState(b));
      return byState
        || latestTime(b) - latestTime(a)
        || String(a.branch || a.worktree || a.event_id || "").localeCompare(String(b.branch || b.worktree || b.event_id || ""));
    })
    .slice(0, limit);
}

export function highestAgentState(tasks) {
  return agentTaskState(topAgentTasks(tasks, 1)[0]);
}

export function latestAgentTask(tasks) {
  return [...(tasks || [])].sort((a, b) => latestTime(b) - latestTime(a))[0] || null;
}

function counterBucket(state) {
  if (activeStatuses.has(state)) return "active";
  if (state === "active") return "active";
  if (state === "waiting_for_user" || state === "blocked" || state === "review_required" || state === "merge_ready" || state === "completed") return state;
  return null;
}

export function countsFromTasks(tasks) {
  const counts = {
    waiting_for_user: 0,
    blocked: 0,
    review_required: 0,
    merge_ready: 0,
    active: 0,
    completed: 0,
    total: 0,
  };
  for (const task of tasks || []) {
    const state = agentTaskState(task);
    if (!state) continue;
    // `total` describes every explicit branch status, including stopped,
    // while the legacy priority buckets intentionally keep only active,
    // attention, and completed counts.
    counts.total += 1;
    const bucket = counterBucket(state);
    if (bucket) counts[bucket] += 1;
  }
  return counts;
}

export function projectPriority(project) {
  const state = project?.agent_state || highestAgentState(project?.agent_tasks);
  if (state) return agentStatePriority(state);
  const git = project?.git;
  if (git && (git.conflict > 0 || git.dirty > 0 || git.behind > 0)) return 1;
  if (project?.latest_event || project?.latest_observed_at) return 5;
  return 6;
}

export function projectLatestTime(project) {
  const agent = eventTime(project?.latest_agent_event?.occurred_at);
  const git = eventTime(project?.latest_event?.date);
  return Math.max(agent ?? 0, git ?? 0, Number(project?.latest_observed_at || 0) * 1000);
}

export function sortProjects(projects) {
  return [...(projects || [])].sort((a, b) => {
    const byPriority = projectPriority(a) - projectPriority(b);
    return byPriority || projectLatestTime(b) - projectLatestTime(a) || String(a.name || a.id).localeCompare(String(b.name || b.id));
  });
}

/** Select reports by one exact branch or, for detached reports, one path. */
export function laneAgentTasks(lane, tasks) {
  const laneBranch = lane?.branch;
  return laneBranch ? (tasks || []).filter((task) => task?.branch === laneBranch) : [];
}

function historicalKey(event) {
  const key = agentReportKey(event);
  if (key) return key;
  return null;
}

/**
 * Reconstruct explicit branch statuses as of one observation point. Lifecycle
 * events remain available from `project.events` for the activity timeline,
 * but cannot change this branch projection.
 */
export function agentSnapshotAt(events, at) {
  const cutoff = typeof at === "number" ? at : eventTime(at);
  const ordered = [...(events || [])]
    .filter((event) => {
      const time = eventTime(event?.occurred_at);
      return time !== null && (cutoff === null || time <= cutoff);
    })
    .sort(compareAgentEvents);
  const byKey = new Map();
  for (const event of ordered) {
    const key = historicalKey(event);
    if (!key) continue;
    const current = byKey.get(key);
    if (!isExplicitAgentStatus(event)) continue;
    if (!current || isNewerAgentEvent(event, current)) {
      byKey.set(key, { ...event, kind: "status" });
    }
  }
  return [...byKey.values()].sort((a, b) => latestTime(b) - latestTime(a));
}

export function laneAgentSnapshotAt(lane, events, at) {
  const snapshots = agentSnapshotAt(events, at);
  return lane?.branch ? snapshots.filter((event) => event.branch === lane.branch) : [];
}

/** Apply one persisted explicit status report without requesting new Git data. */
export function mergeAgentSnapshot(project, event) {
  if (!project || !event || !isExplicitAgentStatus(event)) return project;
  const eventKey = agentReportKey(event);
  if (!eventKey) return project;
  const tasks = [...(project.agent_tasks || [])];
  const index = tasks.findIndex((item) => agentReportKey(item) === eventKey);
  if (index >= 0 && !isNewerAgentEvent(event, tasks[index])) return project;
  const normalized = { ...event, kind: "status" };
  if (index >= 0) tasks[index] = { ...tasks[index], ...normalized };
  else tasks.push(normalized);
  const counts = countsFromTasks(tasks);
  const priorityCounts = {
    waiting_for_user: counts.waiting_for_user,
    blocked: counts.blocked,
    review_required: counts.review_required,
    merge_ready: counts.merge_ready,
    active: counts.active,
    completed: counts.completed,
  };
  const previousLatest = project.latest_agent_event;
  return {
    ...project,
    agent_tasks: tasks,
    agent_priority_counts: priorityCounts,
    agent_state: highestAgentState(tasks),
    latest_agent_event: isNewerAgentEvent(event, previousLatest) ? normalized : previousLatest,
  };
}

export function deferProjectOrder(current, next, interactionActive) {
  if (!interactionActive) return { order: [...next], deferred: false };
  const nextIds = new Set(next);
  const retained = current.filter((id) => nextIds.has(id));
  const additions = next.filter((id) => !retained.includes(id));
  return { order: [...retained, ...additions], deferred: retained.join("|") !== next.join("|") };
}

export function applyDeferredProjectOrder(current, next) {
  return deferProjectOrder(current, next, false).order;
}

// Descriptive aliases keep the pure module convenient for consumers that
// phrase the operation in terms of aggregation or selection.
export const aggregateAgentCounts = countsFromTasks;
export const selectTopAgentTasks = topAgentTasks;
export const sortProjectSummaries = sortProjects;
export const selectAgentSnapshotAt = agentSnapshotAt;
export const deferSortOrder = deferProjectOrder;

/** Branch names alone cannot identify a project (many projects have main). */
export function projectMatchesAgentEvent(project, event) {
  return typeof event?.project_id === "string" && event.project_id === project.id;
}

/** Match a status report to one exact branch, or one exact detached path. */
export function laneMatchesAgentEvent(lane, event) {
  return typeof event?.branch === "string" && event.branch ? lane?.branch === event.branch : false;
}

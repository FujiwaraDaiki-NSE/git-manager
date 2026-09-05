// Pure presentation helpers for the agent overview.  Keeping these functions
// free of React and API knowledge makes snapshots easy to test and replace.

export const AGENT_STATE_PRIORITY = [
  "waiting_for_user",
  "blocked",
  "review_required",
  "merge_ready",
  "active",
  "completed",
];

export const AGENT_STATE_LABELS = {
  waiting_for_user: "入力待ち",
  blocked: "問題あり",
  review_required: "レビュー待ち",
  merge_ready: "統合可能",
  active: "実行中",
  completed: "完了",
};

const priority = new Map(AGENT_STATE_PRIORITY.map((state, index) => [state, index]));
const activeStates = new Set(["active", "investigating", "implementing", "testing", "reviewing"]);
const attentionStates = new Set(["waiting_for_user", "blocked", "review_required", "merge_ready"]);

export function agentStateLabel(state) {
  return state ? AGENT_STATE_LABELS[state] || state : "agent 状態不明";
}

export function agentStatePriority(state) {
  if (activeStates.has(state)) return priority.get("active");
  return state && priority.has(state) ? priority.get(state) : AGENT_STATE_PRIORITY.length;
}

export function agentTaskState(task) {
  if (!task) return null;
  if (attentionStates.has(task.attention)) return task.attention;
  if (task.outcome === "completed") return "completed";
  if (activeStates.has(task.run_state)) return "active";
  return task.run_state || task.phase || null;
}

export function eventTime(value) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

function latestTime(item) {
  return eventTime(item?.occurred_at) ?? 0;
}

export function topAgentTasks(tasks, limit = 3) {
  return [...(tasks || [])]
    .filter((task) => task && task.task_id)
    .sort((a, b) => {
      const byState = agentStatePriority(agentTaskState(a)) - agentStatePriority(agentTaskState(b));
      return byState || latestTime(b) - latestTime(a) || String(a.task_id).localeCompare(String(b.task_id));
    })
    .slice(0, limit);
}

export function highestAgentState(tasks) {
  return agentTaskState(topAgentTasks(tasks, 1)[0]);
}

export function latestAgentTask(tasks) {
  return [...(tasks || [])].sort((a, b) => latestTime(b) - latestTime(a))[0] || null;
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
    if (!state || !priority.has(state)) continue;
    const bucket = state;
    counts[bucket] += 1;
    counts.total += 1;
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

export function laneAgentTasks(lane, tasks) {
  const lanePath = lane?.path;
  const laneBranch = lane?.branch;
  return (tasks || []).filter((task) =>
    (lanePath && task.worktree === lanePath) || (laneBranch && task.branch === laneBranch),
  );
}

export function agentSnapshotAt(events, at) {
  const cutoff = typeof at === "number" ? at : eventTime(at);
  const byKey = new Map();
  for (const event of events || []) {
    const time = eventTime(event?.occurred_at);
    if (time === null || (cutoff !== null && time > cutoff)) continue;
    const key = event.task_id || event.worktree || event.branch;
    if (!key) continue;
    const current = byKey.get(key);
    if (!current || time >= (eventTime(current.occurred_at) ?? 0)) byKey.set(key, event);
  }
  return [...byKey.values()].sort((a, b) => latestTime(b) - latestTime(a));
}

export function laneAgentSnapshotAt(lane, events, at) {
  return agentSnapshotAt(events, at).filter((event) =>
    (lane?.path && event.worktree === lane.path) || (lane?.branch && event.branch === lane.branch),
  );
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

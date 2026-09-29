function includesSearchQuery(value, query) {
  return (value ?? "").toLocaleLowerCase().includes(query);
}

export function normalizedSearchQuery(value) {
  return value.trim().toLocaleLowerCase();
}

export function laneMatchesSearch(lane, query) {
  if (!query) return true;
  return [lane.name, lane.branch, lane.path].some((value) => includesSearchQuery(value, query));
}

export function activityMatchesSearch(event, query) {
  if (!query) return true;
  return [
    event.subject,
    event.summary,
    event.author,
    event.agent_id,
    event.branch,
    ...(event.lane_names ?? []),
  ].some((value) => includesSearchQuery(value, query));
}

function activityEventTime(event) {
  if (!event.occurred_at) return null;
  const value = new Date(event.occurred_at).getTime();
  return Number.isNaN(value) ? null : value;
}

export function compareActivityEvents(a, b, order) {
  const aTime = activityEventTime(a);
  const bTime = activityEventTime(b);
  if (aTime === null && bTime !== null) return 1;
  if (aTime !== null && bTime === null) return -1;
  if (aTime !== null && bTime !== null && aTime !== bTime) {
    return order === "newest" ? bTime - aTime : aTime - bTime;
  }
  if (a.observed_at !== b.observed_at) {
    return order === "newest" ? b.observed_at - a.observed_at : a.observed_at - b.observed_at;
  }
  return a.id.localeCompare(b.id);
}

export function laneMatchesFilter(lane, filter) {
  switch (filter) {
    case "all": return true;
    case "dirty": return lane.dirty === true;
    case "conflict": return lane.conflict === true;
    case "ahead": return typeof lane.upstream_ahead === "number" && lane.upstream_ahead > 0;
    case "behind": return typeof lane.upstream_behind === "number" && lane.upstream_behind > 0;
    case "worktree": return lane.is_worktree === true;
    default: return false;
  }
}

export function sortWorkLanes(lanes, order) {
  const priority = (lane) => lane.conflict === true ? 0 : lane.dirty === true ? 1 : typeof lane.error === "string" && lane.error.length > 0 ? 2 : lane.worktree_state === "prunable" || lane.worktree_state === "locked" ? 3 : lane.upstream_behind > 0 ? 4 : lane.upstream_ahead > 0 ? 5 : 6;
  const timestamp = (lane) => {
    if (!lane.last_commit?.date) return -Infinity;
    const date = Date.parse(lane.last_commit.date);
    return Number.isFinite(date) ? date : -Infinity;
  };
  return [...lanes].sort((a, b) => {
    if (order === "attention" && priority(a) !== priority(b)) return priority(a) - priority(b);
    if (order === "latest" && timestamp(a) !== timestamp(b)) return timestamp(b) - timestamp(a);
    return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
}

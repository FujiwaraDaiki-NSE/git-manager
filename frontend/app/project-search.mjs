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

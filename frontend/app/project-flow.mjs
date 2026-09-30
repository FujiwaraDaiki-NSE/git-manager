const CONTROL_TABS = new Set(["flow", "lanes", "activity", "info"]);
const TIME_RANGES = new Set(["current", "24h", "7d", "all"]);

/**
 * Parse URL state without depending on the current component tree. Keeping
 * this pure lets Next soft navigation and browser history use one contract.
 */
export function parseProjectUrl(search) {
  const params = new URLSearchParams(search || "");
  const defaults = {
    tab: "flow", range: "current", laneFilter: "all", laneOrder: "name",
    activityFilter: "all", activityOrder: "newest",
  };
  const choices = {
    tab: CONTROL_TABS, range: TIME_RANGES,
    laneFilter: new Set(["all", "dirty", "conflict", "ahead", "behind", "worktree"]),
    laneOrder: new Set(["name", "latest", "attention"]),
    activityFilter: new Set(["all", "commit", "edit", "test", "review", "input"]),
    activityOrder: new Set(["newest", "oldest"]),
  };
  const invalidParams = [];
  const values = Object.fromEntries(Object.entries(defaults).map(([key, value]) => {
    const provided = params.get(key);
    if (provided !== null && !choices[key].has(provided)) invalidParams.push(key);
    return [key, provided === null ? value : provided];
  }));
  const atParam = params.get("at");
  const at = atParam === null ? 100 : Number(atParam);
  if (atParam !== null && (atParam.trim() === "" || !Number.isFinite(at) || at < 0 || at > 100)) invalidParams.push("at");
  const mergedParam = params.get("merged");
  if (mergedParam !== null && mergedParam !== "true" && mergedParam !== "false") invalidParams.push("merged");
  return {
    path: params.get("path"),
    tab: values.tab,
    range: values.range,
    laneFilter: values.laneFilter,
    laneOrder: values.laneOrder,
    activityFilter: values.activityFilter,
    activityOrder: values.activityOrder,
    merged: mergedParam === "true",
    event: params.get("event"),
    lane: params.get("lane"),
    branchRow: params.get("branchRow"),
    at,
    laneQuery: params.get("laneQuery") ?? "",
    activityQuery: params.get("activityQuery") ?? "",
    invalidParams,
  };
}

export function updateProjectUrl(href, changes) {
  const url = new URL(href, "http://localhost");
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === undefined || value === "") {
      url.searchParams.delete(key);
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function shouldFoldMergedLane({ merged, is_worktree, dirty, conflict, worktree_state }) {
  // A prunable worktree is no longer an operable checkout, even when the
  // stale lane record still identifies it as a worktree. Dirty/conflicting
  // facts always keep the lane visible so an operator can inspect them.
  if (worktree_state === "prunable") {
    return dirty !== true && conflict !== true;
  }
  const completed = merged === true;
  return completed && is_worktree !== true && dirty !== true && conflict !== true;
}

/**
 * Return a local checkout only when this commit is the unique local HEAD in
 * the row. A remote tip, shared history commit, or duplicated local HEAD has
 * no unambiguous worktree context.
 */
export function uniqueLocalForCommit(locals, hash) {
  const matches = locals.filter((lane) => lane.head === hash);
  return matches.length === 1 ? matches[0] : null;
}

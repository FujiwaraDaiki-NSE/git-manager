const CONTROL_TABS = new Set(["flow", "lanes", "activity", "info"]);
const TIME_RANGES = new Set(["current", "24h", "7d", "all"]);

/**
 * Parse URL state without depending on the current component tree.  Keeping
 * this pure lets both Next soft navigation and browser history use exactly the
 * same contract.
 */
export function parseProjectUrl(search) {
  const params = new URLSearchParams(search || "");
  const tab = params.get("tab");
  const range = params.get("range");
  const at = Number(params.get("at") ?? "100");
  return {
    path: params.get("path"),
    tab: CONTROL_TABS.has(tab) ? tab : "flow",
    range: TIME_RANGES.has(range) ? range : "current",
    event: params.get("event"),
    lane: params.get("lane"),
    at: Number.isFinite(at) ? Math.min(100, Math.max(0, at)) : 100,
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

/**
 * Return one real parent path from merge-base (inclusive) to HEAD (inclusive)
 * in visual/keyboard order.  A merge commit follows the first parent when it
 * can reach the requested base, otherwise it checks the remaining parents;
 * no unrelated older ancestors are appended.
 * @param {Array<{hash: string, parents: string[]}>} graphRows
 * @param {string|null} head
 * @param {string|null} mergeBase
 */
export function ancestryRows(graphRows, head, mergeBase = null) {
  if (!head) return [];
  const byHash = new Map(graphRows.map((row) => [row.hash, row]));
  const headRow = byHash.get(head);
  if (!headRow) return [];
  if (!mergeBase) return [headRow];

  const findPath = (hash, target, visited) => {
    if (hash === target) return [hash];
    if (visited.has(hash)) return null;
    const row = byHash.get(hash);
    if (!row) return null;
    const nextVisited = new Set(visited);
    nextVisited.add(hash);
    for (const parent of row.parents) {
      const path = findPath(parent, target, nextVisited);
      if (path) return [hash, ...path];
    }
    return null;
  };

  const headToBase = findPath(head, mergeBase, new Set());
  if (!headToBase) return [headRow];
  return headToBase.reverse().map((hash) => byHash.get(hash)).filter(Boolean);
}

export function flowEventKey(laneId, hash) {
  return `${laneId}:${hash}`;
}

export function mobileEventAction({ isMobile, isTouch, previewAtPointerDown }) {
  return isMobile && isTouch && !previewAtPointerDown ? "preview" : "select";
}

export function shouldFoldMergedLane({ merged, is_worktree, dirty, conflict, worktree_state }) {
  const completed = merged === true || worktree_state === "prunable";
  return completed && is_worktree !== true && dirty !== true && conflict !== true;
}

/**
 * Return the x position of a merge-base in the currently displayed time
 * window.  The commit can be outside the window, but its real position is
 * still used before clamping to the left/right edge so a line never starts at
 * the first visible event by accident.
 */
export function mergeBasePosition(mergeBaseDate, minTime, maxTime) {
  const base = new Date(mergeBaseDate || "").getTime();
  if (!Number.isFinite(base) || !Number.isFinite(minTime) || !Number.isFinite(maxTime) || maxTime <= minTime) {
    return { x: 0, outside: false, available: false };
  }
  const raw = ((base - minTime) / (maxTime - minTime)) * 100;
  return {
    x: Math.min(100, Math.max(0, raw)),
    outside: raw < 0 || raw > 100,
    available: true,
  };
}

export function flowKeyboardAction(key) {
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key)) return "move";
  if (key === "Enter" || key === " " || key === "Spacebar") return "select";
  return "none";
}

function timestamp(event) {
  const value = new Date(event.row.date).getTime();
  return Number.isNaN(value) ? Number.POSITIVE_INFINITY : value;
}

/**
 * Preserve chronological DOM order and reserve a distinct 44px pointer area
 * per event.  The visible point is offset back to its exact timestamp when
 * neighboring hit areas need to be projected apart.
 */
export function layoutFlowEvents(events, trackWidth = 440) {
  const ordered = [...events].sort((a, b) => timestamp(a) - timestamp(b) || a.id.localeCompare(b.id));
  if (!ordered.length) return [];
  // The caller lays out each lane independently and passes the same width
  // used by the rendered track.  Do not inflate the width from the number of
  // events here: that would make point offsets disagree with the map width.
  const width = Math.max(440, trackWidth);
  const gap = (44 / width) * 100;
  const targetPositions = ordered.map((event) => Math.min(100, Math.max(0, event.x)));
  const positions = [...targetPositions];
  for (let index = 1; index < positions.length; index += 1) {
    positions[index] = Math.max(positions[index], positions[index - 1] + gap);
  }
  for (let index = positions.length - 2; index >= 0; index -= 1) {
    positions[index] = Math.min(positions[index], positions[index + 1] - gap);
  }
  const shift = positions[0] < 0 ? -positions[0] : positions.at(-1) > 100 ? 100 - positions.at(-1) : 0;
  return ordered.map((event, index) => ({
    ...event,
    hitX: positions[index] + shift,
    pointOffset: ((targetPositions[index] - (positions[index] + shift)) / 100) * width,
  }));
}

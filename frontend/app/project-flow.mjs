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
    // The merged-lane filter is a project-level view preference. Keep it in
    // the URL so switching tabs/ranges and browser history restore the same
    // filter in both the flow and lane register views.
    merged: params.get("merged") === "true",
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
 * per event.  When neighboring events need to be projected apart, the
 * interaction point moves with its hit area and the caller draws a leader
 * back to ``timestampX``. This keeps the visible point and keyboard/pointer
 * target centered on the same event.
 */
export function layoutFlowEvents(events, trackWidth = 440) {
  // Graph rows already carry the display/ancestry order (parent before child).
  // Keep that input index as the only equal-time tie-breaker; hashes are
  // identifiers, not a visual or keyboard ordering contract.
  const ordered = events
    .map((event, inputIndex) => ({ event, inputIndex }))
    .sort((a, b) => timestamp(a.event) - timestamp(b.event) || a.inputIndex - b.inputIndex)
    .map(({ event }) => event);
  if (!ordered.length) return [];
  // The caller lays out each lane independently and passes the same width
  // used by the rendered track.  Do not inflate the width from the number of
  // events here: that would make point offsets disagree with the map width.
  const width = Math.max(440, trackWidth);
  const gap = (44 / width) * 100;
  // Keep the target center inside a full 44px control. Besides avoiding
  // clipping at the track edge, this guarantees the required ±12px pointer
  // checks still resolve to the same event on a narrow viewport.
  const edge = (22 / width) * 100;
  const minPosition = edge;
  const maxPosition = 100 - edge;
  const timestampPositions = ordered.map((event) => Math.min(100, Math.max(0, event.x)));
  const targetPositions = timestampPositions.map((position) => Math.min(maxPosition, Math.max(minPosition, position)));
  const positions = [...targetPositions];
  for (let index = 1; index < positions.length; index += 1) {
    positions[index] = Math.max(positions[index], positions[index - 1] + gap);
  }
  for (let index = positions.length - 2; index >= 0; index -= 1) {
    positions[index] = Math.min(positions[index], positions[index + 1] - gap);
  }
  const shift = positions[0] < minPosition ? minPosition - positions[0] : positions.at(-1) > maxPosition ? maxPosition - positions.at(-1) : 0;
  return ordered.map((event, index) => ({
    ...event,
    hitX: positions[index] + shift,
    timestampX: timestampPositions[index],
    pointOffset: 0,
  }));
}

/**
 * Clamp a popover around its post-collision interaction point to the visible
 * horizontal scroll viewport. The returned offset is relative to the event
 * hit center, so the arrow can still identify the event after clamping.
 */
export function popoverPlacement({
  pointX,
  viewportLeft,
  viewportRight,
  preferredWidth = 290,
  margin = 8,
}) {
  const viewportWidth = Math.max(0, viewportRight - viewportLeft);
  const width = Math.min(preferredWidth, Math.max(0, viewportWidth - margin * 2));
  if (width <= 0) return { width: 0, center: pointX, offset: 0 };
  const minCenter = viewportLeft + margin + width / 2;
  const maxCenter = viewportRight - margin - width / 2;
  const center = Math.min(maxCenter, Math.max(minCenter, pointX));
  return { width, center, offset: center - pointX };
}

/**
 * Geometry for the non-interactive leader connecting a collision-displaced
 * point to its true timestamp. The result is lane-local and uses the same
 * rendered track width as ``layoutFlowEvents``.
 */
export function eventLeaderGeometry(timestampX, hitX, trackWidth = 440) {
  const width = Math.max(440, trackWidth);
  const offset = ((timestampX - hitX) / 100) * width;
  return {
    offset,
    left: Math.min(0, offset),
    width: Math.abs(offset),
  };
}

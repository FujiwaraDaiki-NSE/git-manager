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

// A one-hour transition keeps the most recent hour nearly linear while
// progressively compressing older time. Both directions share this constant.
const RECENT_TIME_UNIT = 3_600_000;

export function recentTimePosition(time, minTime, maxTime) {
  if (![time, minTime, maxTime].every(Number.isFinite) || maxTime <= minTime) throw new RangeError("Invalid time scale");
  if (time <= minTime) return 0;
  if (time >= maxTime) return 100;
  return 100 * (1 - Math.log1p((maxTime - time) / RECENT_TIME_UNIT)
    / Math.log1p((maxTime - minTime) / RECENT_TIME_UNIT));
}

export function recentTimeAt(position, minTime, maxTime) {
  if (![position, minTime, maxTime].every(Number.isFinite) || maxTime <= minTime) throw new RangeError("Invalid time scale");
  if (position <= 0) return minTime;
  if (position >= 100) return maxTime;
  return maxTime - RECENT_TIME_UNIT * Math.expm1((1 - position / 100)
    * Math.log1p((maxTime - minTime) / RECENT_TIME_UNIT));
}

/** Calendar-aligned labels, with a fixed minimum pixel distance on the
 * logarithmic axis. Candidates are generated near each desired position,
 * avoiding a scan through every minute of long histories.
 */
export function graphTimeTicks(minTime, maxTime, trackWidth) {
  if (!Number.isFinite(trackWidth) || trackWidth < 100) throw new RangeError("Invalid tick width");
  const count = Math.min(9, Math.floor(trackWidth / 100) + 1);
  const gap = trackWidth / (count - 1);
  const room = (gap - 90) / 2;
  const steps = [604800000, 86400000, 21600000, 10800000, 3600000, 1800000, 900000, 300000, 60000, 30000, 15000, 5000, 1000];
  const times = [minTime];
  for (let i = 1; i < count - 1; i++) {
    const center = i * gap;
    const target = recentTimeAt(center / trackWidth * 100, minTime, maxTime);
    let chosen = null;
    for (const step of steps) {
      const date = new Date(target);
      if (step >= 86400000) {
        date.setHours(0, 0, 0, 0);
        if (step === 604800000) date.setDate(date.getDate() - (date.getDay() + 6) % 7);
      } else if (step >= 3600000) {
        date.setHours(Math.floor(date.getHours() / (step / 3600000)) * (step / 3600000), 0, 0, 0);
      } else if (step >= 60000) {
        date.setMinutes(Math.floor(date.getMinutes() / (step / 60000)) * (step / 60000), 0, 0);
      } else {
        date.setSeconds(Math.floor(date.getSeconds() / (step / 1000)) * (step / 1000), 0);
      }
      const next = new Date(date);
      if (step >= 86400000) next.setDate(next.getDate() + step / 86400000);
      else next.setTime(next.getTime() + step);
      const candidates = [date.getTime(), next.getTime()].filter((time) => time > minTime && time < maxTime
        && Math.abs(recentTimePosition(time, minTime, maxTime) / 100 * trackWidth - center) <= room);
      candidates.sort((a,b) => Math.abs(a-target) - Math.abs(b-target));
      if (candidates.length) { chosen = candidates[0]; break; }
    }
    if (chosen !== null) times.push(chosen);
  }
  times.push(maxTime);
  const dayKey = (date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  const includeYear = new Date(minTime).getFullYear() !== new Date(maxTime).getFullYear();
  const includeSeconds = maxTime - minTime < 300000;
  return times.map((time, index) => {
    const date = new Date(time);
    const newDay = index === 0 || dayKey(date) !== dayKey(new Date(times[index-1]));
    return {
      time, position: recentTimePosition(time, minTime, maxTime),
      dateLabel: newDay ? date.toLocaleDateString("ja-JP", { ...(includeYear ? { year: "numeric" } : {}), month: "numeric", day: "numeric" }) : null,
      timeLabel: date.toLocaleTimeString("ja-JP", {hour:"2-digit",minute:"2-digit", ...(includeSeconds ? {second:"2-digit"} : {})}),
      edge: index === 0 ? "start" : index === times.length - 1 ? "end" : null,
    };
  });
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
  return {
    x: recentTimePosition(base, minTime, maxTime),
    outside: base < minTime || base > maxTime,
    available: true,
  };
}

/**
 * Resolve authoritative merge relations to visible lane coordinates. A link
 * is drawable only when both branch names were resolved by the API and both
 * corresponding lanes are present in the current folded/filter view.
 */
export function mergeRelationLinks(relations, lanes, minTime, maxTime, observationTime, graphRows) {
  const rowsByHash = new Map(graphRows.map((row) => [row.hash, row]));
  const laneIndexes = new Map(lanes.map((lane, index) => [lane.id, index]));
  return relations.flatMap((relation) => {
    if (!relation.source_lane_id || !relation.target_lane_id) return [];
    const sourceIndex = laneIndexes.get(relation.source_lane_id);
    const targetIndex = laneIndexes.get(relation.target_lane_id);
    if (sourceIndex === undefined || targetIndex === undefined || sourceIndex === targetIndex) return [];
    if (!mergeRelationInWindow(relation, minTime, maxTime, observationTime)) return [];
    const position = mergeBasePosition(relation.occurred_at, minTime, maxTime);
    if (!position.available) return [];
    const sourceRow = rowsByHash.get(relation.source_parent);
    const sourceTime = sourceRow?.date == null ? NaN : new Date(sourceRow.date).getTime();
    const mergeTime = new Date(relation.occurred_at).getTime();
    const sourceX = Number.isFinite(sourceTime) && sourceTime <= mergeTime
      ? recentTimePosition(sourceTime, minTime, maxTime) : null;
    return [{ ...relation, ...position, sourceX, sourceOutside: sourceTime < minTime, sourceIndex, targetIndex }];
  });
}

/** Keep every control point between the source-parent and merge timestamps.
 * Prefer 16px separation where time permits. In a short interval subdivide
 * its free gaps rather than routing backward or beyond the merge time.
 */
export function routeMergeLinks(links, trackWidth, rowHeight) {
  if (trackWidth <= 0 || rowHeight <= 0) throw new RangeError("Invalid merge routing size");
  const routed = [];
  const ordered = links.filter((link) => link.sourceX !== null).sort((a, b) => a.x - b.x
    || a.sourceIndex - b.sourceIndex || a.targetIndex - b.targetIndex
    || a.commit_hash.localeCompare(b.commit_hash)
    || a.source_parent.localeCompare(b.source_parent));
  for (const link of ordered) {
    const startX = link.sourceX * trackWidth / 100;
    const endX = link.x * trackWidth / 100;
    if (!Number.isFinite(startX) || startX > endX) throw new RangeError("Invalid merge timestamps");
    const low = Math.min(link.sourceIndex, link.targetIndex);
    const high = Math.max(link.sourceIndex, link.targetIndex);
    const occupied = routed.filter((other) => low <= other.high && high >= other.low);
    const preferred = Math.max(startX, endX - 24);
    const candidates = Array.from({length: Math.floor((endX - startX) / 16) + 1}, (_, i) => startX + i * 16)
      .filter((x) => x > startX && x < endX)
      .sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred) || a - b);
    let channel = candidates.find((x) => occupied.every((other) => Math.abs(other.channel - x) >= 16));
    if (channel === undefined) {
      const boundaries = [startX, ...occupied.map((other) => other.channel).filter((x) => x > startX && x < endX), endX].sort((a,b) => a-b);
      let gapStart = startX, gapEnd = startX;
      for (let i = 1; i < boundaries.length; i++) {
        if (boundaries[i] - boundaries[i-1] > gapEnd - gapStart) { gapStart = boundaries[i-1]; gapEnd = boundaries[i]; }
      }
      channel = (gapStart + gapEnd) / 2;
    }
    const sourceY = (link.sourceIndex + .5) * rowHeight;
    const targetY = (link.targetIndex + .5) * rowHeight;
    const direction = Math.sign(targetY - sourceY);
    const radius = Math.min(6, channel - startX, endX - channel);
    const middleY = (sourceY + targetY) / 2;
    routed.push({ ...link, low, high, channel, startX, endX,
      path: `M ${startX} ${sourceY} H ${channel - radius} Q ${channel} ${sourceY} ${channel} ${sourceY + direction * radius} V ${targetY - direction * radius} Q ${channel} ${targetY} ${channel + radius} ${targetY} H ${endX}`,
      arrow: `M ${channel - 4} ${middleY - direction * 4} L ${channel} ${middleY + direction * 3} L ${channel + 4} ${middleY - direction * 4}`,
    });
  }
  return routed;
}

export function mergeRelationInWindow(relation, minTime, maxTime, observationTime) {
  const occurredAt = new Date(relation.occurred_at || "").getTime();
  return Number.isFinite(occurredAt)
    && occurredAt >= minTime
    && occurredAt <= maxTime
    && occurredAt <= observationTime;
}

export function mergeRelationTimes(relations, range, observationTime) {
  if (range === "current") return [];
  const cutoff = range === "24h"
    ? observationTime - 86_400_000
    : range === "7d"
      ? observationTime - 604_800_000
      : null;
  return relations.flatMap((relation) => {
    const occurredAt = new Date(relation.occurred_at || "").getTime();
    return Number.isFinite(occurredAt)
      && occurredAt <= observationTime
      && (cutoff === null || occurredAt >= cutoff)
      ? [occurredAt]
      : [];
  });
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
 * Place a body-level flow popover around its event button.  Coordinates are
 * viewport-relative because the caller renders the popover with position:fixed.
 */
export function flowPopoverPlacement({
  anchorLeft,
  anchorRight,
  anchorTop,
  anchorBottom,
  viewportWidth,
  viewportHeight,
  preferredWidth,
  preferredHeight,
  margin,
  gap,
  preferBelow,
}) {
  const width = Math.min(preferredWidth, Math.max(0, viewportWidth - margin * 2));
  const height = Math.min(preferredHeight, Math.max(0, viewportHeight - margin * 2));
  const anchorCenter = (anchorLeft + anchorRight) / 2;
  const maxLeft = Math.max(margin, viewportWidth - margin - width);
  const left = Math.min(maxLeft, Math.max(margin, anchorCenter - width / 2));
  const minTop = margin;
  const maxTop = Math.max(minTop, viewportHeight - margin - height);
  const belowTop = anchorBottom + gap;
  const aboveTop = anchorTop - gap - height;
  const belowFits = belowTop <= maxTop;
  const aboveFits = aboveTop >= minTop;
  const side = preferBelow
    ? (belowFits || !aboveFits ? "below" : "above")
    : (aboveFits || !belowFits ? "above" : "below");
  const preferredTop = side === "below" ? belowTop : aboveTop;
  const top = Math.min(maxTop, Math.max(minTop, preferredTop));
  return {
    left,
    top,
    width,
    height,
    side,
  };
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

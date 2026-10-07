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
    relationRef: params.get("relationRef"),
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

const RECENT_TIME_UNIT = 3_600_000;

export function flowEventKey(laneId, hash) {
  return `${laneId}:${hash}`;
}

export function mobileEventAction({ isMobile, isTouch, previewAtPointerDown }) {
  return isMobile && isTouch && !previewAtPointerDown ? "preview" : "select";
}

export function recentTimePosition(time, minTime, maxTime) {
  if (![time, minTime, maxTime].every(Number.isFinite) || maxTime <= minTime) throw new RangeError("Invalid time scale");
  if (time <= minTime) return 0;
  if (time >= maxTime) return 100;
  return 100 * (1 - Math.log1p((maxTime - time) / RECENT_TIME_UNIT) / Math.log1p((maxTime - minTime) / RECENT_TIME_UNIT));
}

export function recentTimeAt(position, minTime, maxTime) {
  if (![position, minTime, maxTime].every(Number.isFinite) || maxTime <= minTime) throw new RangeError("Invalid time scale");
  if (position <= 0) return minTime;
  if (position >= 100) return maxTime;
  return maxTime - RECENT_TIME_UNIT * Math.expm1((1 - position / 100) * Math.log1p((maxTime - minTime) / RECENT_TIME_UNIT));
}

export function graphTimeTicks(minTime, maxTime, trackWidth) {
  if (!Number.isFinite(trackWidth) || trackWidth < 100) throw new RangeError("Invalid tick width");
  const count = Math.min(9, Math.floor(trackWidth / 100) + 1);
  const gap = trackWidth / (count - 1);
  const room = (gap - 90) / 2;
  const steps = [604800000, 86400000, 21600000, 10800000, 3600000, 1800000, 900000, 300000, 60000, 30000, 15000, 5000, 1000];
  const times = [minTime];
  for (let i = 1; i < count - 1; i += 1) {
    const center = i * gap;
    const target = recentTimeAt(center / trackWidth * 100, minTime, maxTime);
    let chosen = null;
    for (const step of steps) {
      const date = new Date(target);
      if (step >= 86400000) {
        date.setHours(0, 0, 0, 0);
        if (step === 604800000) date.setDate(date.getDate() - (date.getDay() + 6) % 7);
      } else if (step >= 3600000) date.setHours(Math.floor(date.getHours() / (step / 3600000)) * (step / 3600000), 0, 0, 0);
      else if (step >= 60000) date.setMinutes(Math.floor(date.getMinutes() / (step / 60000)) * (step / 60000), 0, 0);
      else date.setSeconds(Math.floor(date.getSeconds() / (step / 1000)) * (step / 1000), 0);
      const next = new Date(date);
      next.setTime(next.getTime() + step);
      const candidates = [date.getTime(), next.getTime()].filter((time) => time > minTime && time < maxTime && Math.abs(recentTimePosition(time, minTime, maxTime) / 100 * trackWidth - center) <= room);
      candidates.sort((a, b) => Math.abs(a - target) - Math.abs(b - target));
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
    const newDay = index === 0 || dayKey(date) !== dayKey(new Date(times[index - 1]));
    return { time, position: recentTimePosition(time, minTime, maxTime), dateLabel: newDay ? date.toLocaleDateString("ja-JP", { ...(includeYear ? { year: "numeric" } : {}), month: "numeric", day: "numeric" }) : null, timeLabel: date.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", ...(includeSeconds ? { second: "2-digit" } : {}) }), edge: index === 0 ? "start" : index === times.length - 1 ? "end" : null };
  });
}

export function flowKeyboardAction(key) {
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key)) return "move";
  if (key === "Enter" || key === " " || key === "Spacebar") return "select";
  return "none";
}

export function layoutFlowEvents(events, trackWidth = 440) {
  const ordered = events.map((event, inputIndex) => ({ event, inputIndex })).sort((a, b) => {
    const aTime = new Date(a.event.row.date || "").getTime();
    const bTime = new Date(b.event.row.date || "").getTime();
    return (Number.isFinite(aTime) ? aTime : Number.POSITIVE_INFINITY) - (Number.isFinite(bTime) ? bTime : Number.POSITIVE_INFINITY) || a.inputIndex - b.inputIndex;
  }).map(({ event }) => event);
  if (!ordered.length) return [];
  const width = Math.max(440, trackWidth);
  const gap = 44 / width * 100;
  const edge = 22 / width * 100;
  const timestamps = ordered.map((event) => Math.min(100, Math.max(0, event.x)));
  const positions = timestamps.map((position) => Math.min(100 - edge, Math.max(edge, position)));
  for (let index = 1; index < positions.length; index += 1) positions[index] = Math.max(positions[index], positions[index - 1] + gap);
  for (let index = positions.length - 2; index >= 0; index -= 1) positions[index] = Math.min(positions[index], positions[index + 1] - gap);
  const shift = positions[0] < edge ? edge - positions[0] : positions.at(-1) > 100 - edge ? 100 - edge - positions.at(-1) : 0;
  return ordered.map((event, index) => ({ ...event, hitX: positions[index] + shift, timestampX: timestamps[index], pointOffset: 0 }));
}

export function flowPopoverPlacement({ anchorLeft, anchorRight, anchorTop, anchorBottom, viewportWidth, viewportHeight, preferredWidth, preferredHeight, margin, gap, preferBelow }) {
  const width = Math.min(preferredWidth, Math.max(0, viewportWidth - margin * 2));
  const height = Math.min(preferredHeight, Math.max(0, viewportHeight - margin * 2));
  const maxLeft = Math.max(margin, viewportWidth - margin - width);
  const left = Math.min(maxLeft, Math.max(margin, (anchorLeft + anchorRight) / 2 - width / 2));
  const minTop = margin;
  const maxTop = Math.max(minTop, viewportHeight - margin - height);
  const belowTop = anchorBottom + gap;
  const aboveTop = anchorTop - gap - height;
  const belowFits = belowTop <= maxTop;
  const aboveFits = aboveTop >= minTop;
  const side = preferBelow ? (belowFits || !aboveFits ? "below" : "above") : (aboveFits || !belowFits ? "above" : "below");
  const top = Math.min(maxTop, Math.max(minTop, side === "below" ? belowTop : aboveTop));
  return { left, top, width, height, side };
}

export function eventLeaderGeometry(timestampX, hitX, trackWidth = 440) {
  const offset = ((timestampX - hitX) / 100) * Math.max(440, trackWidth);
  return { offset, left: Math.min(0, offset), width: Math.abs(offset) };
}

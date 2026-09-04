export const RANGE_SECONDS = {
  "24h": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
  "30d": 30 * 24 * 60 * 60,
};

export const LANE_GAP = 68;
export const TRUNK_Y = 42;
export const LANE_TOP = 96;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function commitTimestamp(commit) {
  if (finite(commit?.timestamp)) return commit.timestamp;
  if (typeof commit?.date === "string") {
    const parsed = Date.parse(commit.date);
    if (Number.isFinite(parsed)) return parsed / 1000;
  }
  return null;
}

function allTimestamps(data) {
  const values = [];
  for (const commit of data.trunk ?? []) {
    const timestamp = commitTimestamp(commit);
    if (timestamp !== null) values.push(timestamp);
  }
  for (const branch of data.branches ?? []) {
    if (finite(branch.fork_time)) values.push(branch.fork_time);
    if (finite(branch.merged_at)) values.push(branch.merged_at);
    for (const commit of branch.commits ?? []) {
      const timestamp = commitTimestamp(commit);
      if (timestamp !== null) values.push(timestamp);
    }
  }
  return values;
}

export function timelineWindow(data, range) {
  if (range !== "all" && !Object.hasOwn(RANGE_SECONDS, range)) {
    throw new Error(`unknown timeline range: ${range}`);
  }
  if (!finite(data?.now)) throw new Error("timeline now is required");
  const end = data.now;
  if (range !== "all") {
    return { start: end - RANGE_SECONDS[range], end };
  }
  const values = allTimestamps(data);
  const start = values.length ? Math.min(...values) : end - RANGE_SECONDS["24h"];
  return { start: Math.min(start, end), end };
}

export function timeToX(timestamp, window, width) {
  if (!finite(timestamp) || !finite(width)) return null;
  if (window.end <= window.start) return width;
  const ratio = (timestamp - window.start) / (window.end - window.start);
  return Math.max(0, Math.min(width, ratio * width));
}

function dirtyRecord(dirtyWorktrees, worktree) {
  if (!worktree || !dirtyWorktrees) return null;
  if (dirtyWorktrees instanceof Map) return dirtyWorktrees.get(worktree) ?? null;
  if (dirtyWorktrees instanceof Set) return dirtyWorktrees.has(worktree) ? true : null;
  if (Array.isArray(dirtyWorktrees)) return dirtyWorktrees.includes(worktree) ? true : null;
  return null;
}

function dirtyCountRecord(record) {
  if (!record) return 0;
  if (record === true) return 1;
  if (Array.isArray(record.entries)) return record.entries.length;
  if (Array.isArray(record.counts)) {
    return record.counts.reduce((sum, count) => sum + (Number(count.count) || 0), 0);
  }
  return 0;
}

export function dirtyCount(dirtyWorktrees, worktree) {
  return dirtyCountRecord(dirtyRecord(dirtyWorktrees, worktree));
}

export function baseDirtyCount(data, dirtyWorktrees) {
  if (!data?.base || !(dirtyWorktrees instanceof Map)) return 0;
  for (const record of dirtyWorktrees.values()) {
    if (record && record.is_worktree === false && record.branch === data.base.name) {
      return dirtyCountRecord(record);
    }
  }
  return 0;
}

function latestBranchTimestamp(branch) {
  const commits = branch.commits ?? [];
  let latest = null;
  for (const commit of commits) {
    const timestamp = commitTimestamp(commit);
    if (timestamp !== null && (latest === null || timestamp > latest)) latest = timestamp;
  }
  return latest;
}

export function classifyBranch(branch, now, dirtyWorktrees) {
  if (!finite(now)) throw new Error("timeline now is required");
  if (branch?.merged) {
    return { key: "merged", label: "merged", token: "merged" };
  }
  const dirty = dirtyCount(dirtyWorktrees, branch?.worktree) > 0;
  const latest = latestBranchTimestamp(branch);
  const recent = latest !== null && now - latest <= 30 * 60;
  if (dirty || recent) {
    return { key: "working", label: "作業中", token: "worktree" };
  }
  if ((branch?.behind ?? 0) > 0) {
    return { key: "behind", label: "behind", token: "behind" };
  }
  if ((branch?.ahead ?? 0) > 0 && (branch?.behind ?? 0) === 0) {
    return { key: "ready", label: "ready", token: "ahead" };
  }
  return { key: "synced", label: "同期", token: "clean" };
}

function pointFromCommit(commit, x, y, extra = {}) {
  return {
    id: `${extra.lane ?? "commit"}:${commit.hash}`,
    kind: "commit",
    hash: commit.hash,
    x,
    y,
    timestamp: commitTimestamp(commit),
    commit,
    ...extra,
  };
}

function inWindow(timestamp, window) {
  return timestamp !== null && timestamp >= window.start && timestamp <= window.end;
}

function lineCoordinates(points) {
  return points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
}

function tickStep(rangeSeconds) {
  if (rangeSeconds <= 24 * 60 * 60) return 4 * 60 * 60;
  if (rangeSeconds <= 7 * 24 * 60 * 60) return 24 * 60 * 60;
  if (rangeSeconds <= 30 * 24 * 60 * 60) return 5 * 24 * 60 * 60;
  return Math.max(24 * 60 * 60, Math.round(rangeSeconds / 6 / (24 * 60 * 60)) * 24 * 60 * 60);
}

function tickText(timestamp, rangeSeconds) {
  const date = new Date(timestamp * 1000);
  if (rangeSeconds <= 24 * 60 * 60) {
    return new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" }).format(date);
  }
  return new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric" }).format(date);
}

function makeTicks(window) {
  const step = tickStep(window.end - window.start);
  const first = Math.ceil(window.start / step) * step;
  const ticks = [];
  for (let timestamp = first; timestamp <= window.end; timestamp += step) {
    ticks.push({ timestamp, label: tickText(timestamp, window.end - window.start) });
  }
  return ticks;
}

export function buildTimelineGeometry(data, options = {}) {
  const range = options.range ?? "all";
  const width = options.width ?? 960;
  const dirtyWorktrees = options.dirtyWorktrees ?? null;
  const baseDirty = baseDirtyCount(data, dirtyWorktrees);
  const window = timelineWindow(data, range);
  const branches = data.branches ?? [];
  const trunkPoints = [];
  const allPoints = [];
  for (const commit of data.trunk ?? []) {
    const timestamp = commitTimestamp(commit);
    if (!inWindow(timestamp, window)) continue;
    const point = pointFromCommit(commit, timeToX(timestamp, window, width), TRUNK_Y, {
      lane: "trunk",
      branchName: data.base?.name,
      isBaseHead: data.base?.hash === commit.hash,
      marker: data.base?.hash === commit.hash ? "head" : "commit",
      dirtyCount: baseDirty,
    });
    trunkPoints.push(point);
    allPoints.push(point);
  }
  if (baseDirty > 0 && data.base?.hash) {
    const baseHeadCommit = (data.trunk ?? []).find((commit) => commit.hash === data.base.hash);
    const dirtyPoint = {
      id: "dirty:trunk",
      kind: "commit",
      hash: data.base.hash,
      lane: "trunk",
      branchName: data.base.name,
      x: timeToX(window.end, window, width),
      y: TRUNK_Y,
      timestamp: window.end,
      commit: baseHeadCommit,
      marker: "dirty-head",
      dirtyCount: baseDirty,
      isBaseHead: true,
      isHead: true,
    };
    trunkPoints.push(dirtyPoint);
    allPoints.push(dirtyPoint);
  }

  const lanes = branches.map((branch, index) => {
    const y = LANE_TOP + index * LANE_GAP;
    const status = classifyBranch(branch, data.now, dirtyWorktrees);
    const branchDirtyCount = dirtyCount(dirtyWorktrees, branch.worktree);
    const dirty = branchDirtyCount > 0;
    const forkTimestamp = finite(branch.fork_time) ? branch.fork_time : null;
    const forkX = timeToX(forkTimestamp, window, width);
    const points = [];
    const route = [];
    if (forkX !== null) {
      const forkPoint = {
        id: `fork:${branch.name}`,
        kind: "fork",
        hash: branch.merge_base,
        lane: branch.name,
        branchName: branch.name,
        x: forkX,
        y,
        timestamp: forkTimestamp,
        branch,
        behind: branch.behind ?? 0,
      };
      points.push(forkPoint);
      allPoints.push(forkPoint);
      route.push({ x: forkX, y: TRUNK_Y }, { x: forkX, y });
    }
    for (const commit of branch.commits ?? []) {
      const timestamp = commitTimestamp(commit);
      if (!inWindow(timestamp, window)) continue;
      const point = pointFromCommit(commit, timeToX(timestamp, window, width), y, {
        lane: branch.name,
        branchName: branch.name,
        branch,
        isHead: commit.hash === branch.hash,
        marker: commit.hash === branch.hash ? (status.key === "merged" ? "merged-head" : "head") : "commit",
      });
      points.push(point);
      allPoints.push(point);
      route.push({ x: point.x, y: point.y });
    }
    if (branch.merged && finite(branch.merged_at)) {
      const mergeTimestamp = branch.merged_at;
      const mergeX = timeToX(mergeTimestamp, window, width);
      if (mergeX !== null) {
        const mergePoint = {
          id: `merge:${branch.name}`,
          kind: "merge",
          hash: branch.merge_hash,
          lane: branch.name,
          branchName: branch.name,
          x: mergeX,
          y,
          timestamp: mergeTimestamp,
          branch,
        };
        points.push(mergePoint);
        allPoints.push(mergePoint);
        route.push({ x: mergeX, y }, { x: mergeX, y: TRUNK_Y });
      }
    }
    if (dirty && branch.hash) {
      const branchHeadCommit = (branch.commits ?? []).find((commit) => commit.hash === branch.hash);
      const dirtyPoint = {
        id: `dirty:${branch.name}`,
        kind: "commit",
        hash: branch.hash,
        lane: branch.name,
        branchName: branch.name,
        x: timeToX(window.end, window, width),
        y,
        timestamp: window.end,
        commit: branchHeadCommit,
        branch,
        marker: "dirty-head",
        dirtyCount: branchDirtyCount,
        isHead: true,
      };
      points.push(dirtyPoint);
      allPoints.push(dirtyPoint);
      if (!branch.merged) route.push({ x: dirtyPoint.x, y });
    }
    if (route.length === 0 && forkX !== null) route.push({ x: forkX, y: TRUNK_Y }, { x: forkX, y });
    return {
      branch,
      index,
      y,
      status,
      dirty,
      dirtyCount: branchDirtyCount,
      points,
      route,
      line: lineCoordinates(route),
    };
  });

  return {
    width,
    height: Math.max(LANE_TOP + branches.length * LANE_GAP + 36, 136),
    start: window.start,
    end: window.end,
    trunkY: TRUNK_Y,
    trunk: { points: trunkPoints, line: lineCoordinates([{ x: 0, y: TRUNK_Y }, { x: width, y: TRUNK_Y }]) },
    lanes,
    points: allPoints,
    ticks: makeTicks(window).map((tick) => ({
      ...tick,
      x: timeToX(tick.timestamp, window, width),
    })),
  };
}

export function relativeTime(timestamp, now) {
  if (!finite(timestamp) || !finite(now)) return "時刻不明";
  const seconds = Math.round(now - timestamp);
  if (Math.abs(seconds) < 60) return seconds >= 0 ? "たった今" : "まもなく";
  const minutes = Math.round(Math.abs(seconds) / 60);
  if (minutes < 60) return seconds >= 0 ? `${minutes}分前` : `${minutes}分後`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return seconds >= 0 ? `${hours}時間前` : `${hours}時間後`;
  const days = Math.round(hours / 24);
  return seconds >= 0 ? `${days}日前` : `${days}日後`;
}

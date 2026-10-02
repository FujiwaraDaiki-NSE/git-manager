/*
 * Pure helpers for the worktree inventory.  The worktree snapshot is the
 * source of truth for inventory membership; a lane is supplemental context
 * and is linked only when its path is exactly equal to the worktree path.
 */

export const WORKTREE_STATE_FILTERS = Object.freeze([
  "all",
  "main",
  "ok",
  "detached",
  "prunable",
  "locked",
  "unknown",
]);

export const WORKTREE_HEALTH_FILTERS = Object.freeze([
  "all",
  "dirty",
  "conflict",
  "clean",
  "unknown",
]);

export const WORKTREE_STATE_LABELS = Object.freeze({
  all: "すべて",
  main: "メイン作業場所",
  ok: "利用可能",
  detached: "detached",
  prunable: "参照先なし",
  locked: "ロック中",
  unknown: "状態未取得",
});

export const WORKTREE_HEALTH_LABELS = Object.freeze({
  all: "すべて",
  dirty: "変更あり",
  conflict: "競合",
  clean: "変更なし",
  unknown: "未取得",
});

/** Return the final path component without making a platform-specific API call. */
export function basename(value) {
  if (typeof value !== "string" || value.length === 0) return "";
  const withoutTrailingSeparators = value.replace(/[\\/]+$/, "");
  if (withoutTrailingSeparators.length === 0) return value;
  const separator = Math.max(
    withoutTrailingSeparators.lastIndexOf("/"),
    withoutTrailingSeparators.lastIndexOf("\\"),
  );
  return withoutTrailingSeparators.slice(separator + 1);
}

export function normalizedWorktreeQuery(value) {
  return typeof value === "string" ? value.trim().toLocaleLowerCase() : "";
}

function exactLaneForPath(path, lanes) {
  let match = null;
  let count = 0;
  for (const lane of lanes) {
    if (lane && lane.path === path) {
      match = lane;
      count += 1;
    }
  }
  return count === 1 ? match : null;
}

/** Build inventory rows from project.worktrees while linking only exact lane paths. */
export function buildWorktreeInventory(project) {
  return project.worktrees.map((worktree) => ({
    worktree,
    lane: exactLaneForPath(worktree.path, project.lanes),
  }));
}

/** The raw worktree state remains independent from main/detached identity flags. */
export function worktreeState(worktree) {
  if (worktree.state === "prunable") return "prunable";
  if (worktree.state === "locked") return "locked";
  if (worktree.state === "ok") return "ok";
  return "unknown";
}

export function worktreeStateTokens(worktree) {
  const tokens = [];
  if (worktree.is_main === true) tokens.push("main");
  if (worktree.detached === true) tokens.push("detached");
  const state = worktreeState(worktree);
  if (!tokens.includes(state)) tokens.push(state);
  return tokens;
}

export function worktreeStateLabel(worktree) {
  return WORKTREE_STATE_LABELS[worktreeState(worktree)];
}

export function worktreeStateMatches(row, filter) {
  const worktree = row.worktree;
  switch (filter) {
    case "all": return true;
    case "main": return worktree.is_main === true;
    case "ok": return worktree.state === "ok";
    case "detached": return worktree.detached === true;
    case "prunable": return worktree.state === "prunable";
    case "locked": return worktree.state === "locked";
    case "unknown": return worktree.state !== "ok" && worktree.state !== "prunable" && worktree.state !== "locked";
    default: return false;
  }
}

/** Worktree health is known only when both dirty and conflict facts are known. */
export function worktreeHealth(row) {
  const lane = row.lane;
  if (!lane) return "unknown";
  if (lane.conflict === true) return "conflict";
  if (lane.dirty === true) return "dirty";
  if (lane.conflict === false && lane.dirty === false) return "clean";
  return "unknown";
}

export function worktreeHealthTokens(row) {
  const lane = row.lane;
  if (!lane) return ["unknown"];
  const tokens = [];
  if (lane.dirty === true) tokens.push("dirty");
  if (lane.conflict === true) tokens.push("conflict");
  if (lane.dirty === false && lane.conflict === false) tokens.push("clean");
  if (
    lane.dirty === null || lane.dirty === undefined
    || lane.conflict === null || lane.conflict === undefined
  ) tokens.push("unknown");
  if (tokens.length === 0) tokens.push("unknown");
  return tokens;
}

export function worktreeHealthMatches(row, filter) {
  if (filter === "all") return true;
  const lane = row.lane;
  if (filter === "dirty") return lane?.dirty === true;
  if (filter === "conflict") return lane?.conflict === true;
  if (filter === "clean") return lane?.dirty === false && lane?.conflict === false;
  if (filter === "unknown") {
    return !lane
      || lane.dirty === null || lane.dirty === undefined
      || lane.conflict === null || lane.conflict === undefined;
  }
  return false;
}

function searchableValues(row) {
  const worktree = row.worktree;
  const lane = row.lane;
  return [
    worktree.path,
    basename(worktree.path),
    worktree.branch,
    worktree.head,
    lane?.id,
    lane?.name,
    lane?.branch,
    worktreeState(worktree),
    ...worktreeStateTokens(worktree),
    worktreeHealth(row),
  ];
}

export function worktreeMatchesSearch(row, query) {
  const normalized = normalizedWorktreeQuery(query);
  if (!normalized) return true;
  return searchableValues(row).some(
    (value) => typeof value === "string" && value.toLocaleLowerCase().includes(normalized),
  );
}

export function filterWorktreeInventory(rows, options) {
  const query = normalizedWorktreeQuery(options.query);
  const state = options.state;
  const health = options.health;
  return rows.filter((row) => (
    worktreeMatchesSearch(row, query)
    && worktreeStateMatches(row, state)
    && worktreeHealthMatches(row, health)
  ));
}

function compareNullableText(a, b) {
  const aKnown = typeof a === "string" && a.length > 0;
  const bKnown = typeof b === "string" && b.length > 0;
  if (aKnown !== bKnown) return aKnown ? -1 : 1;
  if (!aKnown && !bKnown) return 0;
  return a.localeCompare(b);
}

function branchSortValue(row) {
  // project.worktrees owns branch membership; lane.branch is for linked details.
  return row.worktree.branch;
}

function statusRank(row) {
  const health = worktreeHealth(row);
  if (health === "conflict") return 0;
  if (health === "dirty") return 1;
  const state = worktreeState(row.worktree);
  if (state === "prunable") return 2;
  if (state === "locked") return 3;
  if (state === "unknown") return 7;
  if (row.worktree.detached === true) return 4;
  if (row.worktree.is_main === true) return 5;
  if (state === "ok") return 6;
  return 7;
}

/** Return a sorted copy; the caller's authoritative array is never mutated. */
export function sortWorktreeInventory(rows, order) {
  return [...rows].sort((a, b) => {
    if (order === "branch") {
      const branch = compareNullableText(branchSortValue(a), branchSortValue(b));
      if (branch !== 0) return branch;
    } else if (order === "path") {
      const path = compareNullableText(a.worktree.path, b.worktree.path);
      if (path !== 0) return path;
    } else if (order === "status") {
      const status = statusRank(a) - statusRank(b);
      if (status !== 0) return status;
    }
    const path = compareNullableText(a.worktree.path, b.worktree.path);
    if (path !== 0) return path;
    return String(a.worktree.head ?? "").localeCompare(String(b.worktree.head ?? ""));
  });
}

export function summarizeWorktreeInventory(rows) {
  const count = (predicate) => rows.reduce((total, row) => total + (predicate(row) ? 1 : 0), 0);
  return {
    total: rows.length,
    main: count((row) => worktreeStateMatches(row, "main")),
    ok: count((row) => worktreeStateMatches(row, "ok")),
    detached: count((row) => worktreeStateMatches(row, "detached")),
    prunable: count((row) => worktreeStateMatches(row, "prunable")),
    locked: count((row) => worktreeStateMatches(row, "locked")),
    unknown: count((row) => worktreeStateMatches(row, "unknown")),
    dirty: count((row) => row.lane?.dirty === true),
    conflict: count((row) => row.lane?.conflict === true),
    healthUnknown: count((row) => worktreeHealthTokens(row).includes("unknown")),
  };
}

/** POSIX shell single-quote escaping. The input must be the actual path string. */
export function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function worktreeCdCommand(path) {
  if (typeof path !== "string" || path.length === 0) return null;
  return `cd -- ${shellQuote(path)}`;
}

function tsvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value)
    .replace(/\t/g, " ")
    .replace(/\r\n|\r|\n/g, " ");
  // Prefix spreadsheet formula-like cells after removing delimiter/newline risk.
  return /^[\s\uFEFF]*[=+\-@]/.test(text) ? `'${text}` : text;
}

export const escapeTsvCell = tsvCell;

export const WORKTREE_TSV_HEADERS = Object.freeze([
  "path",
  "branch",
  "head",
  "state",
  "is_main",
  "detached",
  "dirty",
  "conflict",
  "lane_id",
]);

/** Serialize only the supplied, already-filtered inventory rows. */
export function worktreeInventoryTsv(rows) {
  const lines = [WORKTREE_TSV_HEADERS.map(tsvCell).join("\t")];
  for (const row of rows) {
    const lane = row.lane;
    lines.push([
      row.worktree.path,
      row.worktree.branch,
      row.worktree.head,
      row.worktree.state,
      row.worktree.is_main,
      row.worktree.detached,
      lane?.dirty,
      lane?.conflict,
      lane?.id,
    ].map(tsvCell).join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

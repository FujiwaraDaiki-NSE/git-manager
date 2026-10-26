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

export const WORKTREE_SYNC_FILTERS = Object.freeze([
  "all",
  "ahead",
  "behind",
  "diverged",
  "synced",
  "no-upstream",
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

export const WORKTREE_SYNC_LABELS = Object.freeze({
  all: "すべて",
  ahead: "ahead（未push）",
  behind: "behind（未pull）",
  diverged: "分岐",
  synced: "同期済み",
  "no-upstream": "追跡先なし",
  unknown: "同期状態未取得",
});

export const WORKTREE_UPSTREAM_FILTER_LABELS = Object.freeze({
  all: "すべて",
  "no-upstream": "追跡先なし",
  unknown: "追跡先未取得",
});

export const WORKTREE_HEAD_FILTER_LABELS = Object.freeze({
  all: "すべて",
  duplicate: "同じHEADのみ",
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

/**
 * Classify only the upstream facts published on the linked lane.  A missing
 * lane, missing upstream field, or incomplete/invalid tracking counts is
 * explicitly unknown; default-branch counts are a different relation.
 */
export function worktreeSync(row) {
  const lane = row.lane;
  if (!lane) return "unknown";
  if (lane.upstream === null) return "no-upstream";
  if (typeof lane.upstream !== "string" || lane.upstream.length === 0) return "unknown";
  const ahead = lane.upstream_ahead;
  const behind = lane.upstream_behind;
  if (!Number.isInteger(ahead) || ahead < 0 || !Number.isInteger(behind) || behind < 0) return "unknown";
  if (ahead === 0 && behind === 0) return "synced";
  if (ahead > 0 && behind === 0) return "ahead";
  if (ahead === 0 && behind > 0) return "behind";
  if (ahead > 0 && behind > 0) return "diverged";
  return "unknown";
}

export function worktreeSyncLabel(row) {
  return WORKTREE_SYNC_LABELS[worktreeSync(row)];
}

export function worktreeSyncMatches(row, filter) {
  return filter === "all" || worktreeSync(row) === filter;
}

/** Preserve the distinction between an explicit null upstream and an absent fact. */
export function worktreeUpstreamKey(row) {
  const lane = row.lane;
  if (!lane) return "unknown";
  if (lane.upstream === null) return "no-upstream";
  if (typeof lane.upstream !== "string" || lane.upstream.length === 0) return "unknown";
  return `upstream:${lane.upstream}`;
}

export function worktreeUpstreamFilterValue(upstream) {
  if (typeof upstream !== "string" || upstream.length === 0) return null;
  return `upstream:${upstream}`;
}

export function worktreeUpstreamMatches(row, filter) {
  return filter === "all" || worktreeUpstreamKey(row) === filter;
}

function validSyncThreshold(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Parse the optional UI threshold without turning an invalid value into "no filter". */
export function parseWorktreeSyncThreshold(value) {
  if (typeof value !== "string") return { value: null, valid: false };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { value: null, valid: true };
  if (!/^\d+$/.test(trimmed)) return { value: null, valid: false };
  const parsed = Number(trimmed);
  return validSyncThreshold(parsed)
    ? { value: parsed, valid: true }
    : { value: null, valid: false };
}

/** Apply minimum ahead/behind thresholds only to validated, known tracking counts. */
export function worktreeSyncThresholdsMatch(row, minAhead, minBehind) {
  if (minAhead !== null && !validSyncThreshold(minAhead)) return false;
  if (minBehind !== null && !validSyncThreshold(minBehind)) return false;
  if (minAhead === null && minBehind === null) return true;
  const lane = row.lane;
  if (!lane || worktreeSync(row) === "unknown" || worktreeSync(row) === "no-upstream") return false;
  const ahead = lane.upstream_ahead;
  const behind = lane.upstream_behind;
  if (!validSyncThreshold(ahead) || !validSyncThreshold(behind)) return false;
  return (minAhead === null || ahead >= minAhead) && (minBehind === null || behind >= minBehind);
}

export function worktreeHeadKey(row) {
  const head = row.worktree?.head;
  return typeof head === "string" && head.length > 0 ? head : null;
}

export function duplicateWorktreeHeadKeys(rows) {
  const counts = new Map();
  for (const row of rows) {
    const head = worktreeHeadKey(row);
    if (head !== null) counts.set(head, (counts.get(head) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([head]) => head));
}

export function worktreeHeadMatches(row, filter, duplicateHeads) {
  return filter === "all" || (filter === "duplicate" && duplicateHeads.has(worktreeHeadKey(row)));
}

/** Group known HEADs so operators can compare worktree paths sharing one commit. */
export function summarizeWorktreeHeads(rows) {
  const grouped = new Map();
  let unknownCount = 0;
  for (const row of rows) {
    const head = worktreeHeadKey(row);
    if (head === null) {
      unknownCount += 1;
      continue;
    }
    const paths = grouped.get(head) ?? [];
    paths.push(typeof row.worktree.path === "string" && row.worktree.path.length > 0 ? row.worktree.path : "パス未取得");
    grouped.set(head, paths);
  }
  const groups = [...grouped.entries()]
    .map(([head, paths]) => ({ head, paths: [...paths].sort((a, b) => a.localeCompare(b)), count: paths.length }))
    .sort((a, b) => b.count - a.count || a.head.localeCompare(b.head));
  return {
    uniqueCount: groups.length,
    duplicateCount: groups.filter((group) => group.count > 1).length,
    unknownCount,
    groups,
  };
}

/** Return the exact branch option key used by the worktree branch selector. */
export function worktreeBranchFilterValue(branch) {
  if (typeof branch !== "string" || branch.length === 0) return null;
  return `branch:${branch}`;
}

/** Preserve detached and missing branch facts as separate selector values. */
export function worktreeBranchKey(row) {
  const branch = worktreeBranchFilterValue(row.worktree.branch);
  if (branch !== null) return branch;
  if (row.worktree.detached === true) return "detached";
  return "unknown";
}

export function worktreeBranchMatches(row, filter) {
  return filter === "all" || worktreeBranchKey(row) === filter;
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
  const sync = options.sync;
  const branch = options.branch;
  const upstream = options.upstream;
  const head = options.head;
  const duplicateHeads = duplicateWorktreeHeadKeys(rows);
  const minAhead = options.minAhead;
  const minBehind = options.minBehind;
  return rows.filter((row) => (
    worktreeMatchesSearch(row, query)
    && worktreeStateMatches(row, state)
    && worktreeHealthMatches(row, health)
    && worktreeSyncMatches(row, sync)
    && worktreeBranchMatches(row, branch)
    && worktreeUpstreamMatches(row, upstream)
    && worktreeHeadMatches(row, head, duplicateHeads)
    && worktreeSyncThresholdsMatch(row, minAhead, minBehind)
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

/** Serialize one shell command per currently visible worktree. */
export function worktreeCdCommands(rows) {
  return rows
    .map((row) => worktreeCdCommand(row.worktree.path))
    .filter((command) => command !== null)
    .join("\n");
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
  "upstream",
  "upstream_ahead",
  "upstream_behind",
  "upstream_sync",
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
      lane?.upstream,
      lane?.upstream_ahead,
      lane?.upstream_behind,
      worktreeSync(row),
    ].map(tsvCell).join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

function metadataRow(row) {
  const worktree = row.worktree;
  const lane = row.lane;
  const upstreamPresent = Boolean(lane && Object.prototype.hasOwnProperty.call(lane, "upstream"));
  return {
    path: worktree.path,
    branch: worktree.branch,
    head: worktree.head,
    state: worktree.state,
    is_main: worktree.is_main,
    detached: worktree.detached,
    lane: lane ? {
      id: lane.id,
      name: lane.name,
      branch: lane.branch,
      dirty: lane.dirty ?? null,
      conflict: lane.conflict ?? null,
      upstream: lane.upstream ?? null,
      upstream_present: upstreamPresent,
      upstream_ahead: lane.upstream_ahead ?? null,
      upstream_behind: lane.upstream_behind ?? null,
    } : null,
    upstream_sync: worktreeSync(row),
  };
}

/** Serialize only the currently filtered rows while retaining explicit unknown facts. */
export function worktreeInventoryJson(rows, context) {
  return `${JSON.stringify({
    project: context.project,
    main_path: context.mainPath,
    row_count: rows.length,
    filters: context.filters,
    order: context.order,
    worktrees: rows.map(metadataRow),
  }, null, 2)}\n`;
}

function markdownCell(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r\n|\r|\n/g, " ");
}

/** Build a readable Markdown table from the currently displayed inventory. */
export function worktreeInventoryMarkdown(rows, context) {
  const lines = [
    `# Worktree inventory: ${markdownCell(context.project)}`,
    "",
    `作業場所: \`${markdownCell(context.mainPath)}\``,
    `表示件数: ${rows.length}`,
    `並び順: ${markdownCell(context.order)}`,
    "",
    "| Path | Branch | HEAD | State | Health | Upstream | Ahead | Behind |",
    "| --- | --- | --- | --- | --- | --- | ---: | ---: |",
  ];
  for (const row of rows) {
    const head = worktreeHeadKey(row);
    lines.push(`| ${markdownCell(row.worktree.path)} | ${markdownCell(row.worktree.branch)} | ${markdownCell(head ? head.slice(0, 10) : "HEAD 未取得")} | ${markdownCell(row.worktree.state ?? "状態未取得")} | ${markdownCell(worktreeHealth(row))} | ${markdownCell(worktreeUpstreamKey(row).replace(/^upstream:/, ""))} | ${markdownCell(row.lane?.upstream_ahead ?? "未取得")} | ${markdownCell(row.lane?.upstream_behind ?? "未取得")} |`);
  }
  return `${lines.join("\n")}\n`;
}

/** Serialize a deterministic path-to-full-HEAD mapping for scripts and review. */
export function worktreePathHeadJson(rows) {
  const mapping = {};
  for (const row of [...rows].sort((a, b) => String(a.worktree.path ?? "").localeCompare(String(b.worktree.path ?? "")))) {
    const path = row.worktree.path;
    if (typeof path !== "string" || path.length === 0) continue;
    mapping[path] = worktreeHeadKey(row);
  }
  return `${JSON.stringify(mapping, null, 2)}\n`;
}

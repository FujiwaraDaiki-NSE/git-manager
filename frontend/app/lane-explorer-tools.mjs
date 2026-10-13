import { agentTaskState } from "./agent-overview.mjs";

/** A value that cannot collide with a real commit author. */
export const UNKNOWN_LANE_AUTHOR_FILTER = "__gitdash_unknown_lane_author__";
export const LANE_AUTHOR_FILTER_PREFIX = "__gitdash_lane_author__:";

export const LANE_UPSTREAM_FILTERS = Object.freeze([
  "all",
  "synced",
  "ahead",
  "behind",
  "diverged",
  "untracked",
  "unknown",
]);

export const LANE_UPSTREAM_LABELS = Object.freeze({
  all: "すべて",
  synced: "同期済み",
  ahead: "ahead（未push）",
  behind: "behind（未pull）",
  diverged: "分岐",
  untracked: "追跡先なし",
  unknown: "同期状態未取得",
});

function assertLaneList(lanes) {
  if (!Array.isArray(lanes)) throw new TypeError("lanes must be an array");
}

function hasKnownAuthor(lane) {
  return typeof lane?.last_commit?.author === "string" && lane.last_commit.author.length > 0;
}

/** Return the exact author recorded on the lane's latest commit. */
export function laneLastCommitAuthor(lane) {
  return hasKnownAuthor(lane) ? lane.last_commit.author : null;
}

/** Return exact, case-sensitive author values represented by the lanes. */
export function laneAuthors(lanes) {
  assertLaneList(lanes);
  return Array.from(new Set(lanes.filter(hasKnownAuthor).map((lane) => lane.last_commit.author)))
    .sort((left, right) => left.localeCompare(right));
}

/** Keep missing commits and missing author strings available as an explicit choice. */
export function hasUnknownLaneAuthor(lanes) {
  assertLaneList(lanes);
  return lanes.some((lane) => !hasKnownAuthor(lane));
}

/** Encode a known author for a select value without colliding with the unknown token. */
export function encodeLaneAuthor(author) {
  if (typeof author !== "string" || author.length === 0) {
    throw new TypeError("author must be a non-empty string");
  }
  return `${LANE_AUTHOR_FILTER_PREFIX}${encodeURIComponent(author)}`;
}

function decodeAuthorFilter(authorFilter) {
  if (typeof authorFilter !== "string" || !authorFilter.startsWith(LANE_AUTHOR_FILTER_PREFIX)) {
    return { valid: true, value: authorFilter };
  }
  const encoded = authorFilter.slice(LANE_AUTHOR_FILTER_PREFIX.length);
  if (encoded.length === 0) return { valid: false, value: null };
  try {
    const value = decodeURIComponent(encoded);
    return { valid: typeof value === "string" && value.length > 0, value };
  } catch {
    return { valid: false, value: null };
  }
}

/** Match the latest commit author exactly; null and "" explicitly mean no filter. */
export function laneMatchesAuthor(lane, authorFilter) {
  if (authorFilter === undefined) {
    throw new TypeError("authorFilter must be provided explicitly; use null or an empty string for no filter");
  }
  if (authorFilter === null || authorFilter === "") return true;
  if (authorFilter === UNKNOWN_LANE_AUTHOR_FILTER) return !hasKnownAuthor(lane);
  const decoded = decodeAuthorFilter(authorFilter);
  if (!decoded.valid) return false;
  return hasKnownAuthor(lane) && lane.last_commit.author === decoded.value;
}

/**
 * Classify only the lane's upstream facts.  `upstream === null` is the
 * explicit no-tracking fact.  Missing/empty upstream and incomplete counts
 * stay unknown; default-branch divergence is a different relation.
 */
export function laneUpstreamState(lane) {
  if (!lane || typeof lane !== "object") return "unknown";
  if (lane.upstream === null) return "untracked";
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

/** Return whether one lane belongs to an exact upstream synchronization state. */
export function laneMatchesUpstream(lane, upstreamFilter) {
  if (upstreamFilter === undefined) {
    throw new TypeError("upstreamFilter must be provided explicitly; use all for no filter");
  }
  if (upstreamFilter === "all") return true;
  return LANE_UPSTREAM_FILTERS.includes(upstreamFilter) && laneUpstreamState(lane) === upstreamFilter;
}

/** Return the explicit status marker, never a lifecycle/run-state fallback. */
export function laneAgentStatus(lane) {
  return agentTaskState(lane?.agent) ?? null;
}

export function laneAgentStatusValue(lane) {
  return laneAgentStatus(lane) ?? "unknown";
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  const safe = /^[\s\uFEFF]*[=+\-@]/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export const escapeLaneCsvCell = csvCell;

export const LANE_CSV_HEADERS = Object.freeze([
  "branch",
  "path",
  "head",
  "default_ahead",
  "default_behind",
  "upstream",
  "upstream_ahead",
  "upstream_behind",
  "upstream_sync",
  "last_commit_hash",
  "last_commit_subject",
  "last_commit_author",
  "last_commit_date",
  "agent_status",
]);

/** Serialize exactly the already-filtered lanes into a spreadsheet-safe CSV. */
export function laneCsv(lanes) {
  assertLaneList(lanes);
  const lines = [LANE_CSV_HEADERS.map(csvCell).join(",")];
  for (const lane of lanes) {
    const commit = lane?.last_commit ?? null;
    lines.push([
      lane?.branch,
      lane?.path,
      lane?.head,
      lane?.default_ahead,
      lane?.default_behind,
      lane?.upstream,
      lane?.upstream_ahead,
      lane?.upstream_behind,
      laneUpstreamState(lane),
      commit?.hash,
      commit?.subject,
      commit?.author,
      commit?.date,
      laneAgentStatusValue(lane),
    ].map(csvCell).join(","));
  }
  return `\uFEFF${lines.join("\r\n")}`;
}

function markdownCell(value) {
  const text = value === null || value === undefined || value === "" ? "unknown" : String(value);
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replace(/\r\n|\r|\n/g, "⏎");
}

function divergenceLabel(ahead, behind) {
  if (!Number.isInteger(ahead) || ahead < 0 || !Number.isInteger(behind) || behind < 0) return "unknown";
  return `ahead ${ahead} · behind ${behind}`;
}

function lastCommitLabel(lane) {
  const commit = lane?.last_commit;
  if (!commit) return "unknown";
  return [commit.hash, commit.subject, commit.author, commit.date].join(" · ");
}

/** Build a compact Markdown handoff containing the same authoritative facts as the CSV. */
export function laneSummaryMarkdown(project, lanes) {
  if (!project || typeof project !== "object") throw new TypeError("project must be provided");
  assertLaneList(lanes);
  const lines = [
    `# ${markdownCell(project.name)} 作業レーン引き継ぎ`,
    "",
    `- プロジェクトパス: ${markdownCell(project.main_path)}`,
    `- 既定ブランチ: ${markdownCell(project.default_branch)}`,
    `- 一致件数: ${lanes.length}`,
    "",
    "| ブランチ | 作業パス | HEAD | 既定との差 | upstream | upstream ahead | upstream behind | upstream sync | 最終コミット | agent status |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const lane of lanes) {
    lines.push([
      lane?.branch,
      lane?.path,
      lane?.head,
      divergenceLabel(lane?.default_ahead, lane?.default_behind),
      lane?.upstream,
      lane?.upstream_ahead,
      lane?.upstream_behind,
      laneUpstreamState(lane),
      lastCommitLabel(lane),
      laneAgentStatusValue(lane),
    ].map(markdownCell).join(" | "));
    lines[lines.length - 1] = `| ${lines[lines.length - 1]} |`;
  }
  return `${lines.join("\n")}\n`;
}

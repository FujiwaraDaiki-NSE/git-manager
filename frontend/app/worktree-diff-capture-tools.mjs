/** Captured worktree diff observations; these helpers never read current Git state. */
import { buildWorktreeDiffQuery, sameWorktreeDiffRequest, worktreeStageLabel } from "./worktree-diff-tools.mjs";

export const WORKTREE_DIFF_CAPTURE_LIMIT = 5;
export const WORKTREE_EXCLUSION_REASONS = ["untracked", "conflict", "not_in_diff"];

export function worktreeExclusionReasonLabel(reason) {
  if (reason === "untracked") return "未追跡";
  if (reason === "conflict") return "競合";
  if (reason === "not_in_diff") return "差分対象外";
  throw new RangeError(`Unknown worktree exclusion reason: ${reason}`);
}

function requireCount(value, name, nullable) {
  if (nullable && value === null) return;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`);
}

function requireFile(file) {
  if (file === null || typeof file !== "object" || typeof file.path !== "string" || file.path.length === 0 || typeof file.binary !== "boolean") {
    throw new TypeError("Invalid captured file metadata");
  }
  for (const side of ["additions", "deletions"]) {
    if (file[side] !== "-") requireCount(file[side], side, false);
  }
  if (Object.hasOwn(file, "old_path") && (typeof file.old_path !== "string" || file.old_path.length === 0)) {
    throw new TypeError("old_path must be an explicit non-empty string when present");
  }
}

export function worktreeExclusionRows(excluded) {
  if (excluded === null || typeof excluded !== "object") throw new TypeError("Excluded paths must be supplied");
  return WORKTREE_EXCLUSION_REASONS.flatMap((reason) => {
    if (!Array.isArray(excluded[reason]) || excluded[reason].some((path) => typeof path !== "string" || path.length === 0)) {
      throw new TypeError(`Excluded ${reason} paths must be an array of non-empty strings`);
    }
    return excluded[reason].map((path) => ({ path, reason }));
  });
}

export function captureWorktreeDiff(id, request, response, receivedAt) {
  requireCount(id, "Capture id", false);
  if (id === 0) throw new TypeError("Capture id must be positive");
  if (request === null || typeof request !== "object") throw new TypeError("A capture request must be supplied");
  buildWorktreeDiffQuery(request.path, request.stage, request.file, request.ignoreWhitespace);
  if (typeof receivedAt !== "string" || !Number.isFinite(Date.parse(receivedAt))) throw new TypeError("A valid response receipt timestamp must be supplied");
  if (response === null || typeof response !== "object" || response.input === null || typeof response.input !== "object" || response.snapshot === null || typeof response.snapshot !== "object") {
    throw new TypeError("The worktree diff response is incomplete");
  }
  const scope = request.file === null ? "all" : "file";
  for (const actual of [response, response.input, response.snapshot]) {
    if (actual.stage !== request.stage || actual.file !== request.file || actual.ignore_whitespace !== request.ignoreWhitespace) {
      throw new TypeError("The response does not match the requested worktree diff");
    }
  }
  if (response.scope !== scope || response.snapshot.scope !== scope || typeof response.stage_label !== "string" || typeof response.snapshot.stage_label !== "string") {
    throw new TypeError("The captured scope is inconsistent");
  }
  if (!Array.isArray(response.files)) throw new TypeError("Captured files must be supplied");
  response.files.forEach(requireFile);
  if (new Set(response.files.map((file) => file.path)).size !== response.files.length) throw new TypeError("Captured file paths must be unique");
  worktreeExclusionRows(response.excluded);
  if (response.stats === null || typeof response.stats !== "object") throw new TypeError("Captured statistics must be supplied");
  for (const key of ["files", "binary", "renamed"]) requireCount(response.stats[key], key, false);
  for (const key of ["additions", "deletions"]) requireCount(response.stats[key], key, true);
  for (const key of ["patch_complete", "patch_truncated", "metadata_complete"]) {
    if (typeof response[key] !== "boolean") throw new TypeError(`${key} must be explicit`);
  }
  if (response.patch_complete === response.patch_truncated || typeof response.patch !== "string" || typeof response.command !== "string") {
    throw new TypeError("Captured patch coverage is inconsistent");
  }
  requireCount(response.patch_bytes, "Patch bytes", false);
  requireCount(response.patch_limit_bytes, "Patch byte limit", false);
  return { id, request: { ...request }, response, received_at: receivedAt };
}

export function appendWorktreeDiffCapture(captures, capture) {
  if (!Array.isArray(captures)) throw new TypeError("Capture history must be supplied");
  return [capture, ...captures].slice(0, WORKTREE_DIFF_CAPTURE_LIMIT);
}

export function filterWorktreeExclusions(rows, reason, query) {
  if (!Array.isArray(rows) || typeof query !== "string") throw new TypeError("Exclusion rows and a literal query must be supplied");
  if (reason !== "all" && !WORKTREE_EXCLUSION_REASONS.includes(reason)) throw new RangeError(`Unknown exclusion filter: ${reason}`);
  const needle = query.toLocaleLowerCase();
  return rows.filter((row) => (reason === "all" || row.reason === reason) && row.path.toLocaleLowerCase().includes(needle));
}

function captureContext(capture) {
  return {
    capture_id: capture.id,
    repository_path: capture.request.path,
    response_received_at: capture.received_at,
    request: { ...capture.request },
  };
}

export function buildWorktreeDiffCaptureJson(capture) {
  return JSON.stringify({ schema: "gitdash.worktree-diff.capture.v1", ...captureContext(capture), response: capture.response }, null, 2);
}

export function buildWorktreeExcludedJsonl(capture, reason, query) {
  const rows = filterWorktreeExclusions(worktreeExclusionRows(capture.response.excluded), reason, query);
  return rows.map((row) => JSON.stringify({ ...captureContext(capture), filters: { reason, query }, ...row })).join("\n");
}

function fenced(value, language) {
  const runs = value.match(/`+/g);
  const longest = runs === null ? 0 : runs.reduce((max, run) => Math.max(max, run.length), 0);
  const marker = "`".repeat(Math.max(3, longest + 1));
  return `${marker}${language}\n${value}\n${marker}`;
}

export function buildWorktreeDiffCaptureMarkdown(capture) {
  const data = capture.response;
  const known = (value) => value === null ? "不明" : String(value);
  return [
    "# 作業ツリー差分の取得記録",
    "これは取得済みの観測結果です。現在のファイル状態やコミットの同一性は保証しません。",
    "## 取得条件",
    fenced(JSON.stringify(captureContext(capture), null, 2), "json"),
    `- ステージ: ${worktreeStageLabel(data.stage)}`,
    `- 範囲: ${data.scope === "all" ? "追跡ファイル全体" : "選択ファイル"}`,
    `- 空白変更を無視: ${data.ignore_whitespace ? "はい" : "いいえ"}`,
    `- ファイル一覧: ${data.metadata_complete ? "完全" : "不完全"}`,
    `- パッチ本文: ${data.patch_complete ? "完全" : "部分（上限による切り詰め）"} / ${data.patch_bytes} bytes / 上限 ${data.patch_limit_bytes} bytes`,
    "## 集計",
    `ファイル ${data.stats.files} / 追加行（既知） ${known(data.stats.additions)} / 削除行（既知） ${known(data.stats.deletions)} / バイナリ ${data.stats.binary} / 名前変更・コピー ${data.stats.renamed}`,
    "## 取得した変更ファイル",
    fenced(JSON.stringify(data.files, null, 2), "json"),
    "## APIが報告した除外パス",
    "全未追跡ファイルの一覧ではありません。除外パスの内容は含みません。",
    fenced(JSON.stringify(data.excluded, null, 2), "json"),
    "## 再現コマンド（読み取り専用）",
    fenced(data.command, "sh"),
    `## ${data.patch_complete ? "取得したパッチ" : "取得した部分パッチ"}`,
    fenced(data.patch, "diff"),
  ].join("\n\n");
}

function sameFileMetadata(left, right) {
  return left.additions === right.additions
    && left.deletions === right.deletions
    && left.binary === right.binary
    && Object.hasOwn(left, "old_path") === Object.hasOwn(right, "old_path")
    && left.old_path === right.old_path;
}

function exclusionMap(excluded) {
  const map = new Map();
  for (const { path, reason } of worktreeExclusionRows(excluded)) {
    if (map.has(path)) map.get(path).push(reason);
    else map.set(path, [reason]);
  }
  return map;
}

/** Absence means absent from the returned diff, never deleted from the filesystem. */
export function compareWorktreeDiffCaptures(before, after) {
  if (before === null || after === null || !sameWorktreeDiffRequest(before.request, after.request)) {
    throw new TypeError("Only captures of the same explicit request can be compared");
  }
  const oldFiles = new Map(before.response.files.map((file) => [file.path, file]));
  const newFiles = new Map(after.response.files.map((file) => [file.path, file]));
  const metadataComplete = before.response.metadata_complete && after.response.metadata_complete;
  const files = [];
  if (metadataComplete) {
    for (const [path, file] of oldFiles) {
      if (!newFiles.has(path)) files.push({ path, kind: "left", before: file, after: null });
      else if (!sameFileMetadata(file, newFiles.get(path))) files.push({ path, kind: "metadata_changed", before: file, after: newFiles.get(path) });
    }
    for (const [path, file] of newFiles) {
      if (!oldFiles.has(path)) files.push({ path, kind: "entered", before: null, after: file });
    }
    files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  }
  const oldExcluded = exclusionMap(before.response.excluded);
  const newExcluded = exclusionMap(after.response.excluded);
  const exclusions = [];
  for (const [path, reasons] of oldExcluded) {
    if (!newExcluded.has(path)) exclusions.push({ path, kind: "left", before: reasons, after: [] });
    else if (JSON.stringify(reasons) !== JSON.stringify(newExcluded.get(path))) exclusions.push({ path, kind: "reason_changed", before: reasons, after: newExcluded.get(path) });
  }
  for (const [path, reasons] of newExcluded) {
    if (!oldExcluded.has(path)) exclusions.push({ path, kind: "entered", before: [], after: reasons });
  }
  exclusions.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const patchEqual = before.response.patch === after.response.patch;
  const patchComplete = before.response.patch_complete && after.response.patch_complete;
  return {
    files,
    metadata_complete: metadataComplete,
    exclusions,
    patch_comparison: patchComplete ? (patchEqual ? "same" : "different") : (patchEqual ? "same_prefix" : "different_prefix"),
  };
}

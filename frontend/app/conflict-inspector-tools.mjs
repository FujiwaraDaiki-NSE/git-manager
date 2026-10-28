/** Pure helpers for the read-only unmerged-index conflict inspector. */

export const CONFLICT_STAGE_BASE = 1;
export const CONFLICT_STAGE_OURS = 2;
export const CONFLICT_STAGE_THEIRS = 3;
export const CONFLICT_STAGES = [CONFLICT_STAGE_BASE, CONFLICT_STAGE_OURS, CONFLICT_STAGE_THEIRS];
export const CONFLICT_STAGE_NAMES = Object.freeze({ 1: "base", 2: "ours", 3: "theirs" });
export const CONFLICT_STAGE_LABELS = Object.freeze({ 1: "BASE", 2: "OURS", 3: "THEIRS" });
export const CONFLICT_FILE_LIMIT = 1000;
export const CONFLICT_INVENTORY_BYTES = 4 * 1024 * 1024;
export const CONFLICT_BLOB_BYTES = 1024 * 1024;
export const CONFLICT_PATCH_BYTES = 200000;

function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be provided explicitly`);
  return value;
}

function requiredHash(value, name) {
  const hash = requiredString(value, name);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(hash)) throw new TypeError(`${name} must be a full Git object hash`);
  return hash.toLowerCase();
}

function requiredStage(stage) {
  if (!Number.isInteger(stage) || !CONFLICT_STAGES.includes(stage)) throw new RangeError("stage must be 1, 2, or 3");
  return stage;
}

export function conflictInventoryQuery(path) {
  requiredString(path, "path");
  return new URLSearchParams({ path }).toString();
}

export function conflictStageQuery(path, file, stage, expectedHash) {
  requiredString(path, "path");
  requiredString(file, "file");
  requiredStage(stage);
  requiredHash(expectedHash, "expectedHash");
  return new URLSearchParams({ path, file, stage: String(stage), expectedHash: expectedHash.toLowerCase() }).toString();
}

export function conflictComparisonQuery(path, file, oursHash, theirsHash) {
  requiredString(path, "path");
  requiredString(file, "file");
  requiredHash(oursHash, "oursHash");
  requiredHash(theirsHash, "theirsHash");
  return new URLSearchParams({ path, file, oursHash: oursHash.toLowerCase(), theirsHash: theirsHash.toLowerCase() }).toString();
}

export const buildConflictInventoryQuery = conflictInventoryQuery;
export const buildConflictStageQuery = conflictStageQuery;
export const buildConflictComparisonQuery = conflictComparisonQuery;

export function conflictStageLabel(stage) {
  return CONFLICT_STAGE_LABELS[requiredStage(stage)];
}

export function conflictStageName(stage) {
  return CONFLICT_STAGE_NAMES[requiredStage(stage)];
}

function requireConflictFile(file) {
  if (!file || typeof file !== "object" || typeof file.path !== "string" || file.path.length === 0) {
    throw new TypeError("conflict file must contain an explicit path");
  }
  return file;
}

export function conflictStageRecord(file, stage) {
  const value = requireConflictFile(file);
  const stageNumber = requiredStage(stage);
  const key = String(stageNumber);
  if (value.stages && typeof value.stages === "object" && !Array.isArray(value.stages)) {
    return value.stages[key] ?? null;
  }
  return value[CONFLICT_STAGE_NAMES[stageNumber]] ?? null;
}

export function conflictStageHash(file, stage) {
  const record = conflictStageRecord(file, stage);
  return record && typeof record.hash === "string" ? record.hash : null;
}

function modeIsRegular(mode) {
  return mode === "100644" || mode === "100755";
}

export function conflictStageAvailability(file, stage) {
  const record = conflictStageRecord(file, stage);
  if (record === null) return { available: false, reason: `${conflictStageLabel(stage)} のINDEX stageがありません。` };
  if (record.kind === "symlink" || record.mode === "120000") return { available: false, reason: "シンボリックリンクはリンク先を追跡せず表示しません。" };
  if (record.kind === "gitlink" || record.mode === "160000") return { available: false, reason: "gitlinkのネストしたリポジトリは表示しません。" };
  if (record.type !== "blob" || !modeIsRegular(record.mode)) return { available: false, reason: "通常のblobファイルではないため表示しません。" };
  if (typeof record.hash !== "string") return { available: false, reason: "INDEXのblob hashを取得できません。" };
  return { available: true, reason: null };
}

export function conflictComparisonAvailability(file) {
  const ours = conflictStageRecord(file, CONFLICT_STAGE_OURS);
  const theirs = conflictStageRecord(file, CONFLICT_STAGE_THEIRS);
  if (ours === null || theirs === null) return { available: false, reason: "OURSとTHEIRSの両方がINDEXにあるファイルだけ比較できます。" };
  if (ours.kind === "symlink" || theirs.kind === "symlink" || ours.mode === "120000" || theirs.mode === "120000") {
    return { available: false, reason: "シンボリックリンクは比較しません。" };
  }
  if (ours.kind === "gitlink" || theirs.kind === "gitlink" || ours.mode === "160000" || theirs.mode === "160000") {
    return { available: false, reason: "gitlinkは比較しません。" };
  }
  if (ours.type !== "blob" || theirs.type !== "blob" || !modeIsRegular(ours.mode) || !modeIsRegular(theirs.mode)) {
    return { available: false, reason: "通常のblobファイル同士だけ比較できます。" };
  }
  if (typeof ours.hash !== "string" || typeof theirs.hash !== "string") return { available: false, reason: "OURS/THEIRSのblob hashを取得できません。" };
  return { available: true, reason: null };
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  const protectedText = /^[\s]*[=+\-@]/u.test(text) ? `'${text}` : text;
  return `"${protectedText.replaceAll('"', '""')}"`;
}

function csvStageValues(file, stage) {
  const record = conflictStageRecord(file, stage);
  return record === null ? [null, null, null, null, null] : [
    record.hash,
    record.mode,
    record.type,
    record.kind,
    record.size,
  ];
}

/** Formula-safe CSV for the retrieved conflict inventory only. */
export function conflictInventoryCsv(files) {
  if (!Array.isArray(files)) throw new TypeError("files must be provided explicitly");
  const rows = [[
    "path",
    "base_hash", "base_mode", "base_type", "base_kind", "base_size",
    "ours_hash", "ours_mode", "ours_type", "ours_kind", "ours_size",
    "theirs_hash", "theirs_mode", "theirs_type", "theirs_kind", "theirs_size",
    "missing_stages",
  ]];
  for (const file of files) {
    const value = requireConflictFile(file);
    rows.push([
      value.path,
      ...csvStageValues(value, CONFLICT_STAGE_BASE),
      ...csvStageValues(value, CONFLICT_STAGE_OURS),
      ...csvStageValues(value, CONFLICT_STAGE_THEIRS),
      Array.isArray(value.missing_stages) ? value.missing_stages.join("|") : "",
    ]);
  }
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function conflictBase64ToBytes(value) {
  requiredString(value, "base64");
  if (typeof atob !== "function") throw new Error("base64 decoding is unavailable");
  let decoded;
  try {
    decoded = atob(value);
  } catch {
    throw new TypeError("base64 is invalid");
  }
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

export function conflictDownloadName(path, stage, extension = "bin") {
  requiredString(path, "path");
  const stageName = conflictStageLabel(stage).toLowerCase();
  const base = path.split("/").at(-1) || "conflict-file";
  const safe = base.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "_") || "conflict-file";
  return `gitdash-conflict-${stageName}-${safe}.${extension}`;
}

export function conflictResponseSnapshotKey(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.snapshot_key === "string") return value.snapshot_key;
  if (value.snapshot && typeof value.snapshot.key === "string") return value.snapshot.key;
  return null;
}

export function isConflictInventory(value) {
  return Boolean(value && typeof value === "object" && Array.isArray(value.files) && typeof value.truncated === "boolean" && typeof value.snapshot_key === "string");
}

export function sameConflictSelection(left, right) {
  if (!left || !right) return false;
  return left.path === right.path && left.file === right.file && left.stage === right.stage && left.hash === right.hash && left.snapshotKey === right.snapshotKey;
}

export const CONFLICT_KINDS = Object.freeze([
  { key: "both-modified", label: "両側で変更", description: "BASE・OURS・THEIRSがINDEXにあります。両側の変更をBASEと照らして確認できます。" },
  { key: "both-added", label: "両側で追加", description: "BASEがなく、OURSとTHEIRSがINDEXにあります。同じパスに追加された内容を確認してください。" },
  { key: "ours-deleted", label: "OURSで削除", description: "BASEとTHEIRSがあり、OURSはありません。片側の削除と、もう片側の内容を確認してください。" },
  { key: "theirs-deleted", label: "THEIRSで削除", description: "BASEとOURSがあり、THEIRSはありません。片側の削除と、もう片側の内容を確認してください。" },
  { key: "both-deleted", label: "両側で削除", description: "BASEだけがINDEXにあります。削除された共通の内容を確認できます。" },
  { key: "ours-added", label: "OURSのみ追加", description: "OURSだけがINDEXにあります。追加された側の内容とマージの経緯を確認してください。" },
  { key: "theirs-added", label: "THEIRSのみ追加", description: "THEIRSだけがINDEXにあります。追加された側の内容とマージの経緯を確認してください。" },
  { key: "unknown", label: "stageなし", description: "取得した一覧にBASE・OURS・THEIRSの情報がありません。一覧を再取得してください。" },
]);

const conflictKindByStages = Object.freeze({ "111": "both-modified", "011": "both-added", "101": "ours-deleted", "110": "theirs-deleted", "100": "both-deleted", "010": "ours-added", "001": "theirs-added", "000": "unknown" });

/** Describes the index topology; it does not infer a merge strategy or branch identity. */
export function conflictFileKind(file) {
  const key = CONFLICT_STAGES.map((stage) => conflictStageRecord(file, stage) === null ? "0" : "1").join("");
  return CONFLICT_KINDS.find((kind) => kind.key === conflictKindByStages[key]);
}

export function conflictFileExtension(file) {
  const basename = requireConflictFile(file).path.split("/").at(-1);
  const dot = basename.lastIndexOf(".");
  return dot <= 0 || dot === basename.length - 1 ? "" : basename.slice(dot).toLowerCase();
}

export function conflictInventoryExtensions(files) {
  if (!Array.isArray(files)) throw new TypeError("files must be provided explicitly");
  return [...new Set(files.map(conflictFileExtension))].sort();
}

export function filterConflictFiles(files, { query, extension, kind }) {
  if (!Array.isArray(files)) throw new TypeError("files must be provided explicitly");
  if (typeof query !== "string") throw new TypeError("query must be provided explicitly");
  if (extension !== null && typeof extension !== "string") throw new TypeError("extension must be a string or null");
  if (kind !== null && !CONFLICT_KINDS.some((entry) => entry.key === kind)) throw new TypeError("kind must be an explicit conflict kind or null");
  const terms = query.toLowerCase().split(/\s+/u).filter((term) => term !== "");
  return files.filter((file) => {
    const value = requireConflictFile(file);
    return terms.every((term) => value.path.toLowerCase().includes(term)) &&
      (extension === null || conflictFileExtension(value) === extension) &&
      (kind === null || conflictFileKind(value).key === kind);
  });
}

export function conflictFileMaximumSize(file) {
  const sizes = CONFLICT_STAGES.map((stage) => conflictStageRecord(file, stage)?.size).filter((size) => typeof size === "number" && Number.isFinite(size) && size >= 0);
  return sizes.length === 0 ? null : Math.max(...sizes);
}

export function sortConflictFiles(files, order) {
  if (!Array.isArray(files)) throw new TypeError("files must be provided explicitly");
  if (!["path-asc", "path-desc", "size-desc", "size-asc"].includes(order)) throw new TypeError("order must be provided explicitly");
  return [...files].sort((left, right) => {
    const leftPath = requireConflictFile(left).path;
    const rightPath = requireConflictFile(right).path;
    const pathOrder = leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
    if (order === "path-asc") return pathOrder;
    if (order === "path-desc") return -pathOrder;
    const leftSize = conflictFileMaximumSize(left);
    const rightSize = conflictFileMaximumSize(right);
    if (leftSize === null) return rightSize === null ? pathOrder : 1;
    if (rightSize === null) return -1;
    return (order === "size-desc" ? rightSize - leftSize : leftSize - rightSize) || pathOrder;
  });
}

/** Boundary navigation never wraps or changes a selection hidden by the filters. */
export function adjacentConflictFile(files, path, direction) {
  if (!Array.isArray(files)) throw new TypeError("files must be provided explicitly");
  requiredString(path, "path");
  if (direction !== -1 && direction !== 1) throw new TypeError("direction must be -1 or 1");
  const index = files.findIndex((file) => requireConflictFile(file).path === path);
  return index < 0 || index + direction < 0 || index + direction >= files.length ? null : files[index + direction].path;
}

export function conflictStageFacts(file) {
  const facts = [];
  const pairs = [[CONFLICT_STAGE_BASE, CONFLICT_STAGE_OURS], [CONFLICT_STAGE_BASE, CONFLICT_STAGE_THEIRS], [CONFLICT_STAGE_OURS, CONFLICT_STAGE_THEIRS]];
  for (const [leftStage, rightStage] of pairs) {
    const left = conflictStageRecord(file, leftStage);
    const right = conflictStageRecord(file, rightStage);
    if (left === null || right === null || typeof left.hash !== "string" || typeof right.hash !== "string") continue;
    if (left.hash.toLowerCase() === right.hash.toLowerCase()) facts.push(`${conflictStageLabel(leftStage)}と${conflictStageLabel(rightStage)}のオブジェクトは同じです。${left.mode === right.mode ? "modeも一致しています。" : "modeは異なります。実行権限やファイル種別を確認してください。"}`);
    else if (left.mode !== right.mode) facts.push(`${conflictStageLabel(leftStage)}と${conflictStageLabel(rightStage)}はオブジェクトとmodeが異なります。`);
  }
  return facts;
}

function shellArgument(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function markdownFence(value, language) {
  const runs = value.match(/`+/gu);
  const longest = runs === null ? 0 : Math.max(...runs.map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${value}\n${fence}`;
}

/** Portable report of one retrieved snapshot, including exact object inspection commands. */
export function conflictFileReport(path, file, snapshotKey, truncated) {
  requiredString(path, "path");
  requireConflictFile(file);
  requiredString(snapshotKey, "snapshotKey");
  if (typeof truncated !== "boolean") throw new TypeError("truncated must be provided explicitly");
  const kind = conflictFileKind(file);
  const metadata = CONFLICT_STAGES.map((stage) => {
    const record = conflictStageRecord(file, stage);
    return `${conflictStageLabel(stage)}: ${record === null ? "INDEX stageなし" : JSON.stringify({ hash: record.hash, mode: record.mode, type: record.type, kind: record.kind, size: record.size })}`;
  }).join("\n");
  const commands = [`git -C ${shellArgument(path)} --literal-pathspecs --no-pager ls-files --unmerged -- ${shellArgument(file.path)}`];
  for (const stage of CONFLICT_STAGES) {
    const hash = conflictStageHash(file, stage);
    if (hash !== null) commands.push(`# ${conflictStageLabel(stage)}\ngit -C ${shellArgument(path)} --no-pager cat-file -p ${shellArgument(requiredHash(hash, "stage hash"))}`);
  }
  return [
    "# Git conflict snapshot",
    markdownFence(`worktree: ${JSON.stringify(path)}\nfile: ${JSON.stringify(file.path)}\nsnapshot: ${JSON.stringify(snapshotKey)}`, "text"),
    `競合の構成: ${kind.label}\n\n${kind.description}`,
    truncated ? "取得一覧は上限で切り詰められています。このレポートは選択した1ファイルの取得情報です。" : "取得一覧内の選択した1ファイルの情報です。",
    markdownFence(metadata, "text"),
    ...conflictStageFacts(file),
    "読み取り専用の確認コマンド（INDEX一覧は実行時点、cat-fileは取得済みhashのオブジェクト）:",
    markdownFence(commands.join("\n\n"), "sh"),
    "OURS / THEIRSはINDEXのstage名です。rebaseなどでは現在のブランチ名との関係を確認してください。",
  ].join("\n\n") + "\n";
}

export const CONFLICT_TEXT_MATCH_LIMIT = 2000;
export const CONFLICT_TEXT_PAGE_LINES = 300;

/** A fixed-size page containing an absolute source line, regardless of its distance from the start. */
export function conflictTextPage(lineCount, lineNumber) {
  if (!Number.isInteger(lineCount) || lineCount < 1) throw new TypeError("lineCount must be a positive integer");
  if (!Number.isInteger(lineNumber) || lineNumber < 1 || lineNumber > lineCount) throw new TypeError("lineNumber must identify a source line");
  const start = Math.floor((lineNumber - 1) / CONFLICT_TEXT_PAGE_LINES) * CONFLICT_TEXT_PAGE_LINES;
  return { start, end: Math.min(start + CONFLICT_TEXT_PAGE_LINES, lineCount) };
}

/** Literal per-line search with a bounded stored result set and an exact total. */
export function findConflictTextMatches(text, query, { caseSensitive, limit }) {
  if (typeof text !== "string" || typeof query !== "string") throw new TypeError("text and query must be provided explicitly");
  if (typeof caseSensitive !== "boolean") throw new TypeError("caseSensitive must be provided explicitly");
  if (!Number.isInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive integer");
  if (query === "") return { matches: [], total: 0, truncated: false };
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), caseSensitive ? "gu" : "giu");
  const matches = [];
  let total = 0;
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(pattern)) {
      total += 1;
      if (matches.length < limit) matches.push({ id: `${index + 1}:${match.index}`, line: index + 1, offset: match.index, length: match[0].length });
    }
  });
  return { matches, total, truncated: total > matches.length };
}

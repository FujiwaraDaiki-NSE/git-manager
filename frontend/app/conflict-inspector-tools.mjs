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

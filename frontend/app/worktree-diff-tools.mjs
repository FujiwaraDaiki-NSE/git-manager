/** Pure helpers for the read-only worktree diff pane. */

export const WORKTREE_DIFF_STAGES = ["staged", "unstaged"];

export function worktreeStageLabel(stage) {
  if (stage === "staged") return "ステージ済み";
  if (stage === "unstaged") return "未ステージ";
  throw new RangeError(`Unknown worktree diff stage: ${stage}`);
}

export function buildWorktreeDiffQuery(path, stage, file, ignoreWhitespace) {
  if (typeof path !== "string" || path.length === 0) {
    throw new TypeError("Repository path must be a non-empty string");
  }
  if (!WORKTREE_DIFF_STAGES.includes(stage)) {
    throw new RangeError(`Unknown worktree diff stage: ${stage}`);
  }
  if (file !== null && (typeof file !== "string" || file.length === 0)) {
    throw new TypeError("Worktree diff file must be a non-empty string or null");
  }
  if (typeof ignoreWhitespace !== "boolean") {
    throw new TypeError("ignoreWhitespace must be a boolean");
  }
  const params = new URLSearchParams({
    path,
    stage,
    file: file === null ? "" : file,
    ignoreWhitespace: String(ignoreWhitespace),
  });
  return params.toString();
}

export function sameWorktreeDiffRequest(left, right) {
  return left !== null
    && right !== null
    && left.path === right.path
    && left.stage === right.stage
    && left.file === right.file
    && left.ignoreWhitespace === right.ignoreWhitespace;
}

function safeFilePart(file) {
  if (file === null) return "all";
  const normalized = file
    .replaceAll("\\", "_")
    .replaceAll("/", "_")
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^\.+$/, "_")
    .slice(0, 96);
  return normalized.length > 0 ? normalized : "file";
}

export function worktreePatchDownloadName({ stage, file, patch_truncated }) {
  if (!WORKTREE_DIFF_STAGES.includes(stage)) {
    throw new RangeError(`Unknown worktree diff stage: ${stage}`);
  }
  if (file !== null && (typeof file !== "string" || file.length === 0)) {
    throw new TypeError("Worktree diff file must be a string or null");
  }
  if (typeof patch_truncated !== "boolean") {
    throw new TypeError("patch_truncated must be a boolean");
  }
  return `worktree-${stage}-${safeFilePart(file)}${patch_truncated ? "-partial" : ""}.patch`;
}

export function worktreePatchDownloadStatus(patchTruncated) {
  if (typeof patchTruncated !== "boolean") {
    throw new TypeError("patchTruncated must be a boolean");
  }
  return patchTruncated
    ? "上限までの部分パッチの保存を開始しました。"
    : "生パッチの保存を開始しました。";
}

export function worktreeExcludedLabel(excluded) {
  if (!excluded || typeof excluded !== "object") return null;
  const labels = [];
  if (Array.isArray(excluded.untracked) && excluded.untracked.length > 0) {
    labels.push(`未追跡 ${excluded.untracked.length} 件`);
  }
  if (Array.isArray(excluded.conflict) && excluded.conflict.length > 0) {
    labels.push(`競合 ${excluded.conflict.length} 件`);
  }
  if (Array.isArray(excluded.not_in_diff) && excluded.not_in_diff.length > 0) {
    labels.push(`差分対象外 ${excluded.not_in_diff.length} 件`);
  }
  return labels.length === 0 ? null : `${labels.join("、")}はGitの差分対象外です。`;
}

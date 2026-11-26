import { fileStatusGroups } from "./file-status.mjs";

/** @returns {Array<"staged" | "unstaged">} */
export function statusDiffStages(xy, filter) {
  const groups = fileStatusGroups(xy);
  if (filter === "staged") return groups.staged ? ["staged"] : [];
  if (filter === "unstaged") return groups.unstaged ? ["unstaged"] : [];
  /** @type {Array<"staged" | "unstaged">} */
  const stages = [];
  if (groups.staged) stages.push("staged");
  if (groups.unstaged) stages.push("unstaged");
  return stages;
}

export function hasNoUncommittedChanges(repo) {
  return repo.entries !== undefined && repo.entries.length === 0
    && !repo.error && !repo.pending && repo.worktree_state !== "prunable";
}

export function responseErrorMessage(status, body) {
  return body !== null && typeof body === "object" && typeof body.detail === "string"
    ? body.detail : `HTTP ${status}`;
}

/**
 * @param {string} path
 * @param {string} hash
 * @param {AbortSignal} signal
 * @returns {Promise<import("./types").CommitDetail>}
 */
export async function fetchCommitDetail(path, hash, signal) {
  const query = new URLSearchParams({ path, hash });
  let response;
  try {
    response = await fetch(`/api/repo/commit?${query}`, { cache: "no-store", signal });
  } catch (reason) {
    if (signal.aborted) throw reason;
    throw new Error("通信に失敗しました。接続を確認してください。");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(responseErrorMessage(response.status, body));
  }
  return response.json().catch(() => {
    throw new Error("コミット詳細の応答を読み取れませんでした。");
  });
}

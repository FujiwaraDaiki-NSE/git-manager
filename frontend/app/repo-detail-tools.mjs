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

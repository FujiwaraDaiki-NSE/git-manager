import type { Repo } from "./types";

export type StatusToken =
  | "index"
  | "worktree"
  | "untracked"
  | "ahead"
  | "behind"
  | "conflict"
  | "tag"
  | "merged"
  | "prunable"
  | "locked"
  | "detached"
  | "pending"
  | "clean";

export type Badge = { text: string; token: StatusToken };

const conflictCodes = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

/** Return the semantic status token used by both badges and status codes. */
export function codeToken(xy: string): StatusToken {
  if (xy === "??") return "untracked";
  if (conflictCodes.has(xy)) return "conflict";
  if (xy[1] !== ".") return "worktree";
  return "index";
}

export function codeColor(xy: string): string {
  return `var(--status-${codeToken(xy)})`;
}

/** All applicable states are returned; callers must not treat these as exclusive. */
export function stateBadges(repo: Repo): Badge[] {
  const badges: Badge[] = [];
  const entries = repo.entries ?? [];
  const counts = repo.counts ?? [];

  for (const count of counts) {
    badges.push({
      text: `${count.xy.replace(/\./g, " ")} ${count.count}`,
      token: codeToken(count.xy),
    });
  }
  if (entries.some((entry) => entry.xy === "??")) {
    if (!badges.some((badge) => badge.token === "untracked"))
      badges.push({ text: "未追跡", token: "untracked" });
  }
  if (entries.some((entry) => conflictCodes.has(entry.xy))) {
    if (!badges.some((badge) => badge.token === "conflict"))
      badges.push({ text: "conflict", token: "conflict" });
  }
  if ((repo.ahead ?? 0) > 0)
    badges.push({ text: `ahead ${repo.ahead}`, token: "ahead" });
  if ((repo.behind ?? 0) > 0)
    badges.push({ text: `behind ${repo.behind}`, token: "behind" });
  if ((repo.stashes ?? 0) > 0)
    badges.push({ text: `stash ${repo.stashes}`, token: "behind" });
  if (repo.worktree_state === "prunable")
    badges.push({ text: "prunable", token: "prunable" });
  if (repo.worktree_state === "locked")
    badges.push({ text: "locked", token: "locked" });
  if (repo.is_worktree && !repo.worktree_state)
    badges.push({ text: "worktree", token: "worktree" });
  if (!repo.is_worktree && (repo.merged_branches?.length ?? 0) > 0) {
    badges.push({
      text: `merged ${repo.merged_branches!.length}`,
      token: "merged",
    });
  }
  if (repo.merged) badges.push({ text: "merged", token: "merged" });
  if (repo.detached) badges.push({ text: "detached", token: "detached" });
  if (repo.pending) badges.push({ text: "pending", token: "pending" });
  if (
    badges.length === 0 &&
    entries.length === 0 &&
    !repo.pending &&
    !repo.error &&
    repo.worktree_state !== "prunable"
  ) {
    badges.push({ text: "clean", token: "clean" });
  }
  return badges;
}

export function hasStatus(repo: Repo, status: StatusToken): boolean {
  return stateBadges(repo).some((badge) => badge.token === status);
}

export function truncationLabel(bytes: number): string {
  return `… ${bytes} KB で省略`;
}

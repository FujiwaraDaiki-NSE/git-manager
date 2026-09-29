/**
 * Pure view helpers for the repository detail panes.
 *
 * These helpers deliberately distinguish an explicit value from an unknown
 * value. A missing upstream/worktree/date must not be inferred from an empty
 * string or from a sibling ref because the API owns those facts.
 */

export const BRANCH_FILTERS = [
  { key: "all", label: "すべて" },
  { key: "current", label: "現在" },
  { key: "worktree", label: "作業場所あり" },
  { key: "untracked-upstream", label: "追跡先なし" },
];

export const BRANCH_SORTS = [
  { key: "name", label: "名前順" },
  { key: "date", label: "更新日順" },
];

export function normalizeRepoQuery(value) {
  return value.trim().toLocaleLowerCase();
}

function branchValue(value) {
  return typeof value === "string" ? value.toLocaleLowerCase() : "";
}

export function branchMatchesSearch(branch, query) {
  const normalized = normalizeRepoQuery(query);
  if (!normalized) return true;
  return [branch.name, branch.upstream, branch.worktree]
    .some((value) => branchValue(value).includes(normalized));
}

export function branchMatchesFilter(branch, filter) {
  if (filter === "all") return true;
  if (filter === "current") return branch.current === true;
  if (filter === "worktree") return typeof branch.worktree === "string" && branch.worktree.length > 0;
  if (filter === "untracked-upstream") return branch.upstream === null;
  return false;
}

function hasWorktree(branch) {
  return typeof branch.worktree === "string" && branch.worktree.length > 0;
}

function mergedBranchIsVisible(branch, showMerged) {
  if (showMerged || branch.current || branch.merged !== true) return true;
  // A null worktree is an explicit "not checked out" fact. Any other
  // value, including an unavailable field, must stay visible for safety.
  return branch.worktree !== null;
}

function dateValue(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function compareNames(left, right) {
  return String(left.name).localeCompare(String(right.name), "ja", { sensitivity: "base" });
}

export function compareBranches(left, right, sort) {
  if (sort === "date") {
    const leftDate = dateValue(left.date);
    const rightDate = dateValue(right.date);
    if (leftDate !== null && rightDate !== null && leftDate !== rightDate) {
      return rightDate - leftDate;
    }
    if (leftDate !== null && rightDate === null) return -1;
    if (leftDate === null && rightDate !== null) return 1;
  }
  return compareNames(left, right);
}

export function sortBranches(branches, sort) {
  return [...branches].sort((left, right) => compareBranches(left, right, sort));
}

export function visibleBranches(branches, { query, filter, showMerged, sort }) {
  return sortBranches(
    branches.filter((branch) => (
      mergedBranchIsVisible(branch, showMerged)
      && branchMatchesFilter(branch, filter)
      && branchMatchesSearch(branch, query)
    )),
    sort,
  );
}

export function changedPathList(entries) {
  return entries.map((entry) => entry.path).join("\n");
}

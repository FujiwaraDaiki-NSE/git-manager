import { FAVORITES_STORAGE_KEY, parseFavoriteIds } from "./home-overview.mjs";
import { projectLatestTime } from "./agent-overview.mjs";

export { FAVORITES_STORAGE_KEY };

/** Browser-local order of recently visited project main paths. */
export const RECENT_PROJECT_PATHS_STORAGE_KEY = "gitdash.project-switcher.recent-paths";

export const PROJECT_SWITCHER_ORDERS = /** @type {const} */ (["recent", "last-opened", "name"]);

/**
 * Parse the browser-local recent path list without accepting a partial value.
 * An absent key is an empty list; malformed data is an explicit storage issue.
 */
export function parseRecentProjectPaths(serialized) {
  if (serialized === null) return [];
  try {
    const value = JSON.parse(serialized);
    return Array.isArray(value) && value.every((item) => typeof item === "string")
      ? [...new Set(value)]
      : null;
  } catch {
    return null;
  }
}

/**
 * Put one exact main_path at the front without changing the input list.
 * A null current path represents the home screen and has no history entry.
 */
export function recordRecentProjectPath(paths, mainPath) {
  if (mainPath === null) return [...paths];
  return [mainPath, ...paths.filter((path) => path !== mainPath)];
}

export function serializeRecentProjectPaths(paths) {
  return JSON.stringify(paths);
}

export function favoriteProjectIds(serialized) {
  const parsed = parseFavoriteIds(serialized);
  return parsed === null ? null : new Set(parsed);
}

function projectMatchesQuery(project, normalizedQuery) {
  if (!normalizedQuery) return true;
  return [project.name, project.main_path, project.remote].some(
    (value) => typeof value === "string" && value.toLocaleLowerCase().includes(normalizedQuery),
  );
}

/**
 * Apply switcher filters while preserving the source array and project IDs.
 * @param {import("./types").ProjectSummary[]} projects
 * @param {{ query: string, favoritesOnly: boolean, recentOnly: boolean, favoriteIds: Set<string>, recentPaths: string[] }} filters
 */
export function filterProjectSwitcherProjects(projects, {
  query,
  favoritesOnly,
  recentOnly,
  favoriteIds,
  recentPaths,
}) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return projects.filter((project) => {
    if (favoritesOnly && !favoriteIds.has(project.id)) return false;
    if (recentOnly && (project.main_path === null || !recentPaths.includes(project.main_path))) return false;
    return projectMatchesQuery(project, normalizedQuery);
  });
}

/**
 * @param {import("./types").ProjectSummary[]} projects
 * @param {Map<string, import("./types").Repo>} repos
 * @param {Parameters<typeof filterProjectSwitcherProjects>[1]} filters
 * @param {string | null} homeQuery
 */
export function findProjectSwitcherWorktrees(projects, repos, filters, homeQuery) {
  const query = filters.query.trim().toLocaleLowerCase();
  if (!query) return [];
  const terms = query.split(/\s+/);

  /** @type {Map<string, { path: string, branch: string | null }[]>} */
  const matchesByProject = new Map();
  for (const repo of repos.values()) {
    if (repo.pending || repo.worktree_state === "prunable") continue;
    const branch = repo.detached === true || typeof repo.branch !== "string" || !repo.branch ? null : repo.branch;
    if (branch === null && repo.detached !== true) continue;
    const checkout = { path: repo.path, branch };
    const matches = matchesByProject.get(repo.common_dir);
    if (matches) matches.push(checkout);
    else matchesByProject.set(repo.common_dir, [checkout]);
  }

  return filterProjectSwitcherProjects(projects, { ...filters, query: "" }).flatMap((project) => {
    const matches = matchesByProject.get(project.id);
    if (project.main_path === null || matches === undefined) return [];
    const mainPath = project.main_path;
    const projectName = project.name.toLocaleLowerCase();
    return matches.flatMap(({ path, branch }) => {
      const checkoutPath = path.toLocaleLowerCase();
      const branchName = branch?.toLocaleLowerCase();
      if (!terms.every((term) => projectName.includes(term) || checkoutPath.includes(term) || branchName?.includes(term))) return [];
      const lane = branch === null ? `worktree:${path}` : `branch:${branch}`;
      const params = new URLSearchParams({ path: mainPath, tab: "flow", range: "7d", lane });
      if (homeQuery) params.set("home", homeQuery);
      return [{ project, path, branch, href: `/project?${params}` }];
    });
  });
}

function projectActivityTime(project) {
  const value = projectLatestTime(project);
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function compareProjectName(left, right) {
  return String(left.name).localeCompare(String(right.name))
    || String(left.id).localeCompare(String(right.id));
}

/**
 * Sort switcher results by the selected explicit order. Projects without a
 * recorded visit or activity time follow the known values in their respective orders.
 * @param {import("./types").ProjectSummary[]} projects
 * @param {typeof PROJECT_SWITCHER_ORDERS[number]} order
 * @param {string[]} recentPaths
 */
export function sortProjectSwitcherProjects(projects, order, recentPaths) {
  if (!PROJECT_SWITCHER_ORDERS.includes(order)) {
    throw new Error(`Unknown project switcher order: ${String(order)}`);
  }
  if (order === "last-opened") {
    const visitRanks = new Map(recentPaths.map((path, index) => [path, index]));
    return [...projects].sort((left, right) => {
      const leftRank = left.main_path === null ? undefined : visitRanks.get(left.main_path);
      const rightRank = right.main_path === null ? undefined : visitRanks.get(right.main_path);
      if (leftRank === undefined && rightRank !== undefined) return 1;
      if (leftRank !== undefined && rightRank === undefined) return -1;
      if (leftRank !== undefined && rightRank !== undefined && leftRank !== rightRank) return leftRank - rightRank;
      return compareProjectName(left, right);
    });
  }
  return [...projects].sort((left, right) => {
    if (order === "name") return compareProjectName(left, right);
    const leftTime = projectActivityTime(left);
    const rightTime = projectActivityTime(right);
    if (leftTime === null && rightTime !== null) return 1;
    if (leftTime !== null && rightTime === null) return -1;
    if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return rightTime - leftTime;
    return compareProjectName(left, right);
  });
}

/** Return the next result anchor index for one keyboard navigation key. */
export function projectSwitcherResultIndex(key, index, count) {
  if (count <= 0 || index < 0 || index >= count) return null;
  if (key === "ArrowDown") return (index + 1) % count;
  if (key === "ArrowUp") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

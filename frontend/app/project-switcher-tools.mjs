import { FAVORITES_STORAGE_KEY, parseFavoriteIds } from "./home-overview.mjs";
import { projectLatestTime } from "./agent-overview.mjs";

export { FAVORITES_STORAGE_KEY };

/** Browser-local order of recently visited project main paths. */
export const RECENT_PROJECT_PATHS_STORAGE_KEY = "gitdash.project-switcher.recent-paths";

export const PROJECT_SWITCHER_ORDERS = ["recent", "name"];

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

/** Apply switcher filters while preserving the source array and project IDs. */
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

function projectActivityTime(project) {
  const value = projectLatestTime(project);
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function compareProjectName(left, right) {
  return String(left.name).localeCompare(String(right.name))
    || String(left.id).localeCompare(String(right.id));
}

/**
 * Sort switcher results by the selected explicit order. Unknown activity is
 * kept after projects with a known authoritative activity time.
 */
export function sortProjectSwitcherProjects(projects, order) {
  if (!PROJECT_SWITCHER_ORDERS.includes(order)) {
    throw new Error(`Unknown project switcher order: ${String(order)}`);
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

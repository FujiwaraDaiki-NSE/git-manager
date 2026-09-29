import { projectLatestTime, sortProjects } from "./agent-overview.mjs";

export const AGENT_SUMMARY_KEYS = [
  "waiting_for_user",
  "blocked",
  "active",
  "review_required",
  "merge_ready",
];

export const AGENT_SUMMARY_LABELS = {
  waiting_for_user: "入力待ち",
  blocked: "問題あり",
  active: "実行中",
  review_required: "レビュー待ち",
  merge_ready: "マージ可能",
  completed: "完了",
};

export const AGENT_COUNT_KEYS = [...AGENT_SUMMARY_KEYS, "completed"];

export const GIT_FILTER_KEYS = ["dirty", "conflict", "ahead", "behind"];

export const HOME_DEFAULT_VIEW = {
  query: "",
  agentFilter: "all",
  gitFilter: "all",
  sort: "priority",
  favoritesOnly: false,
  density: "comfortable",
};

export const FAVORITES_STORAGE_KEY = "gitdash.home.favorites";

const agentSummaryKeySet = new Set(AGENT_SUMMARY_KEYS);
const gitFilterKeySet = new Set(GIT_FILTER_KEYS);
const sortKeySet = new Set(["priority", "name", "latest"]);
const densityKeySet = new Set(["comfortable", "compact"]);

function isAgentFilter(value) {
  return value === "all" || value === "unknown" || agentSummaryKeySet.has(value);
}

function isGitFilter(value) {
  return value === "all" || gitFilterKeySet.has(value);
}

function isSort(value) {
  return sortKeySet.has(value);
}

function isDensity(value) {
  return densityKeySet.has(value);
}

/**
 * Read one authoritative count. A missing key, null, or invalid value means
 * that the source did not publish this count; it must stay unknown in the UI.
 */
export function agentCount(project, key) {
  const counts = project?.agent_priority_counts;
  if (!counts || !Object.prototype.hasOwnProperty.call(counts, key)) return null;
  const value = counts[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function formatAgentCount(value) {
  return value === null ? "?" : String(value);
}

export function unknownAgentSummaryKeys(project) {
  return AGENT_COUNT_KEYS.filter((key) => agentCount(project, key) === null);
}

export function hasUnknownAgentCounts(project) {
  return unknownAgentSummaryKeys(project).length > 0;
}

export function aggregateAgentCounts(projects) {
  return Object.fromEntries(
    AGENT_SUMMARY_KEYS.map((key) => {
      let total = 0;
      for (const project of projects) {
        const value = agentCount(project, key);
        if (value === null) return [key, null];
        total += value;
      }
      return [key, total];
    }),
  );
}

export function countProjectsWithUnknownAgentCounts(projects) {
  return projects.reduce(
    (count, project) => count + (hasUnknownAgentCounts(project) ? 1 : 0),
    0,
  );
}

export function matchesAgentFilter(project, filter) {
  if (filter === "all") return true;
  if (filter === "unknown") return hasUnknownAgentCounts(project);
  const value = agentCount(project, filter);
  return value !== null && value > 0;
}

export function matchesGitFilter(project, filter) {
  if (filter === "all") return true;
  const value = project?.git?.[filter];
  return typeof value === "number" && value > 0;
}

export function projectMatchesView(project, view, favorites) {
  const query = view.query.trim().toLowerCase();
  const searchable = [project.name, project.id, project.remote, project.main_path]
    .filter((item) => typeof item === "string")
    .some((item) => item.toLowerCase().includes(query));
  if (query && !searchable) return false;
  if (!matchesAgentFilter(project, view.agentFilter)) return false;
  if (!matchesGitFilter(project, view.gitFilter)) return false;
  if (view.favoritesOnly && !favorites.has(project.id)) return false;
  return true;
}

export function sortHomeProjects(projects, sort) {
  if (sort === "priority") return sortProjects(projects);
  return [...projects].sort((left, right) => {
    if (sort === "name") {
      return String(left.name).localeCompare(String(right.name))
        || String(left.id).localeCompare(String(right.id));
    }
    return projectLatestTime(right) - projectLatestTime(left)
      || String(left.name).localeCompare(String(right.name))
      || String(left.id).localeCompare(String(right.id));
  });
}

export function parseHomeUrl(search) {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const queryParam = params.get("q");
  const agentParam = params.get("agent");
  const gitParam = params.get("git");
  const sortParam = params.get("sort");
  const densityParam = params.get("density");
  const favoritesParam = params.get("favorites");
  const invalidParams = [];
  if (agentParam !== null && !isAgentFilter(agentParam)) invalidParams.push(`agent=${agentParam}`);
  if (gitParam !== null && !isGitFilter(gitParam)) invalidParams.push(`git=${gitParam}`);
  if (sortParam !== null && !isSort(sortParam)) invalidParams.push(`sort=${sortParam}`);
  if (densityParam !== null && !isDensity(densityParam)) invalidParams.push(`density=${densityParam}`);
  if (favoritesParam !== null && favoritesParam !== "0" && favoritesParam !== "1") invalidParams.push(`favorites=${favoritesParam}`);
  if (invalidParams.length > 0) return { view: null, invalidParams };
  return {
    view: {
      query: queryParam === null ? HOME_DEFAULT_VIEW.query : queryParam,
      agentFilter: agentParam === null ? HOME_DEFAULT_VIEW.agentFilter : agentParam,
      gitFilter: gitParam === null ? HOME_DEFAULT_VIEW.gitFilter : gitParam,
      sort: sortParam === null ? HOME_DEFAULT_VIEW.sort : sortParam,
      favoritesOnly: favoritesParam === "1",
      density: densityParam === null ? HOME_DEFAULT_VIEW.density : densityParam,
    },
    invalidParams,
  };
}

export function homeSearch(view) {
  const params = new URLSearchParams();
  if (view.query) params.set("q", view.query);
  if (view.agentFilter !== HOME_DEFAULT_VIEW.agentFilter) params.set("agent", view.agentFilter);
  if (view.gitFilter !== HOME_DEFAULT_VIEW.gitFilter) params.set("git", view.gitFilter);
  if (view.sort !== HOME_DEFAULT_VIEW.sort) params.set("sort", view.sort);
  if (view.favoritesOnly) params.set("favorites", "1");
  if (view.density !== HOME_DEFAULT_VIEW.density) params.set("density", view.density);
  return params.toString();
}

export function homeHref(view, pathname) {
  const search = homeSearch(view);
  return `${pathname}${search ? `?${search}` : ""}`;
}

export function parseFavoriteIds(serialized) {
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

/** Restore only validated local list settings; never accept a return URL. */
export function homeReturnHref(query) {
  if (query === null) return "/";
  const parsed = parseHomeUrl(query);
  if (parsed.view === null) return `/?${query}`;
  return homeHref(parsed.view, "/");
}

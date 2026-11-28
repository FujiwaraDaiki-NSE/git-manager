import { isAcknowledged } from "./agent-acknowledgements.mjs";
import { AGENT_DECISION_STATUSES, agentReportFreshness } from "./agent-timeline-tools.mjs";
import { agentTaskState, projectLatestTime, sortProjects } from "./agent-overview.mjs";
import { githubRepositoryKey } from "./remote-label.mjs";

/** @param {import("./types").ProjectSummary[]} projects */
export function githubCloneGroupsByProject(projects) {
  /** @type {Map<string, { id: string, main_path: string }[]>} */
  const groups = new Map();
  for (const { id, main_path, remote, remote_status } of projects) {
    if (main_path === null || remote_status !== "configured") continue;
    const key = githubRepositoryKey(remote);
    if (key === null) continue;
    const clone = { id, main_path };
    const group = groups.get(key);
    if (group) group.push(clone);
    else groups.set(key, [clone]);
  }
  const byProject = new Map();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const { id } of group) byProject.set(id, group);
  }
  return byProject;
}

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
  merge_ready: "マージ準備完了",
  completed: "完了",
};

export const AGENT_COUNT_KEYS = [...AGENT_SUMMARY_KEYS, "completed"];

export const GIT_FILTER_KEYS = ["dirty", "conflict", "ahead", "behind", "fetch-failure", "git-status-failure", "prunable"];

export const HOME_DEFAULT_VIEW = {
  query: "",
  agentFilter: "all",
  gitFilter: "all",
  sort: "priority",
  favoritesOnly: false,
  hideDormant: false,
  density: "comfortable",
};

export const FAVORITES_STORAGE_KEY = "gitdash.home.favorites";
export const SAVED_VIEWS_STORAGE_KEY = "gitdash.home.savedViews";

export function parseSavedViews(serialized) {
  if (serialized === null) return [];
  try {
    const entries = JSON.parse(serialized);
    if (!Array.isArray(entries)) return null;
    const names = new Set();
    for (const entry of entries) {
      if (!entry || typeof entry.name !== "string" || !entry.name.trim()
        || entry.name !== entry.name.trim() || names.has(entry.name)) return null;
      names.add(entry.name);
      const view = entry.view;
      if (!view || typeof view.query !== "string" || !isAgentFilter(view.agentFilter)
        || !isGitFilter(view.gitFilter) || !isSort(view.sort) || !isDensity(view.density)
        || typeof view.favoritesOnly !== "boolean" || typeof view.hideDormant !== "boolean") return null;
    }
    return entries.map(({ name, view }) => ({ name, view: Object.fromEntries(
      Object.keys(HOME_DEFAULT_VIEW).map((key) => [key, view[key]]),
    ) }));
  } catch {
    return null;
  }
}

export function homeBranchHref(path, branch, homeQuery) {
  if (typeof path !== "string" || !path || typeof branch !== "string" || !branch) return null;
  const params = new URLSearchParams({ path, tab: "flow", range: "7d", lane: `branch:${branch}` });
  if (homeQuery) params.set("home", homeQuery);
  return `/project?${params}`;
}

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
      let known = projects.length === 0;
      for (const project of projects) {
        const value = agentCount(project, key);
        if (value === null) continue;
        known = true;
        total += value;
      }
      return [key, known ? total : null];
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
  if (filter === "fetch-failure") return project.fetch_status?.result === "failure";
  if (filter === "git-status-failure") return project.git_status_failed > 0;
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
  const dormantParam = params.get("hideDormant");
  const invalidParams = [];
  if (agentParam !== null && !isAgentFilter(agentParam)) invalidParams.push(`agent=${agentParam}`);
  if (gitParam !== null && !isGitFilter(gitParam)) invalidParams.push(`git=${gitParam}`);
  if (sortParam !== null && !isSort(sortParam)) invalidParams.push(`sort=${sortParam}`);
  if (densityParam !== null && !isDensity(densityParam)) invalidParams.push(`density=${densityParam}`);
  if (favoritesParam !== null && favoritesParam !== "0" && favoritesParam !== "1") invalidParams.push(`favorites=${favoritesParam}`);
  if (dormantParam !== null && dormantParam !== "0" && dormantParam !== "1") invalidParams.push("hideDormant=" + dormantParam);
  if (invalidParams.length > 0) return { view: null, invalidParams };
  return {
    view: {
      query: queryParam === null ? HOME_DEFAULT_VIEW.query : queryParam,
      agentFilter: agentParam === null ? HOME_DEFAULT_VIEW.agentFilter : agentParam,
      gitFilter: gitParam === null ? HOME_DEFAULT_VIEW.gitFilter : gitParam,
      sort: sortParam === null ? HOME_DEFAULT_VIEW.sort : sortParam,
      favoritesOnly: favoritesParam === "1",
      hideDormant: dormantParam === "1",
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
  if (view.hideDormant) params.set("hideDormant", "1");
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

export function isDormantProject(project, acknowledgements, now) {
  const date = project.latest_event?.date;
  if (typeof date !== "string" || !Number.isFinite(Date.parse(date))
    || now - Date.parse(date) < 30 * 86400000) return false;
  if (project.git_status_failed !== 0 || project.fetch_status?.result === "failure") return false;
  if (!["dirty", "conflict", "ahead"].every((key) => project.git?.[key] === 0)) return false;
  // The API publishes this exact combination when no agent has reported.
  // Missing fields remain unknown rather than an empty report history.
  if (project.agent_tasks === null
    && ["running", "waiting_for_user", "problem", "reviewing", "integratable"]
      .every((key) => project.agent_counts?.[key] === null)
    && AGENT_COUNT_KEYS.every((key) => project.agent_priority_counts?.[key] === null)) return true;
  if (acknowledgements === null) return false;
  if (agentCount(project, "active") !== 0 || !Array.isArray(project.agent_tasks)) return false;
  for (const key of AGENT_DECISION_STATUSES) {
    const count = agentCount(project, key);
    if (count === null) return false;
    const tasks = project.agent_tasks.filter((task) => agentTaskState(task) === key);
    if (tasks.length !== count || tasks.some((task) => !isAcknowledged(task, acknowledgements))) return false;
  }
  return true;
}

export function homeCardKeyAction(event, { editing, dialogOpen, cardFocused, interactive }) {
  if (editing || dialogOpen || event.defaultPrevented || event.isComposing
    || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  if (event.key === "j") return "next";
  if (event.key === "k") return "previous";
  if (cardFocused && !interactive && (event.key === "Enter" || event.key === "o")) return "open";
  return null;
}

export function homeCardIndex(action, current, length) {
  if (!length) return null;
  if (current < 0) return action === "previous" ? length - 1 : 0;
  return Math.max(0, Math.min(length - 1, current + (action === "previous" ? -1 : 1)));
}

const activeAgentStatuses = new Set(["investigating", "implementing", "testing", "reviewing"]);

export function isActiveAgentTask(task) {
  return activeAgentStatuses.has(agentTaskState(task));
}

/** Count only current progress reports with a verifiable old timestamp. */
export function countOldActiveReports(projects, now) {
  let count = 0;
  for (const project of projects) {
    if (!Array.isArray(project.agent_tasks)) continue;
    for (const task of project.agent_tasks) {
      if (isActiveAgentTask(task) && agentReportFreshness(task.occurred_at, now) === "old") count += 1;
    }
  }
  return count;
}

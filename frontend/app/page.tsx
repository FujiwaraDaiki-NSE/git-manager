"use client";
import { fetchProgressLabel } from "./fetch-progress.mjs";
import { nextAgentCheck } from "./home-next-check.mjs";
import { AgentDecisionDetails } from "./agent-decision";
import { remoteLabel } from "./remote-label.mjs";

import { homeDocumentTitle } from "./agent-attention.mjs";
import Link from "next/link";
import { ACKNOWLEDGEMENTS_STORAGE_KEY, parseAcknowledgements } from "./agent-acknowledgements.mjs";
import type { Acknowledgements } from "./agent-acknowledgements.mjs";
import { FetchFacts, FetchFailureBreakdown, fetchCategoryLabel } from "./git-state-facts";
import GitGuide from "./git-guide";
import WorkspaceExport from "./workspace-export";
import ShortcutHelp from "./shortcut-help";
import ProjectSwitcher from "./project-switcher";
import ThemeControl from "./theme-control";
import RescanControl from "./rescan-control";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AGENT_DECISION_STATUSES } from "./agent-timeline-tools.mjs";
import {
  AGENT_SUMMARY_LABELS,
  FAVORITES_STORAGE_KEY,
  SAVED_VIEWS_STORAGE_KEY,
  parseSavedViews,
  homeBranchHref,
  aggregateAgentCounts,
  countOldActiveReports,
  agentCount,
  countProjectsWithUnknownAgentCounts,
  formatAgentCount,
  homeSearch,
  isDormantProject,
  homeCardKeyAction,
  homeCardIndex,
  matchesGitFilter,
  parseFavoriteIds,
  parseHomeUrl,
  projectMatchesView,
  sortHomeProjects,
  unknownAgentSummaryKeys,
} from "./home-overview.mjs";
import { agentReportKey, agentStateLabel, agentTaskState, deferProjectOrder, projectLatestTime, sortProjects, topAgentTasks } from "./agent-overview.mjs";
import { useProjectsLiveUpdates, useRepoStream } from "./repo-stream";
import type { AgentRunState, ProjectSummary } from "./types";

type AgentSummaryKey = "waiting_for_user" | "blocked" | "active" | "review_required" | "merge_ready";
const summaryCards: Array<{ key: AgentSummaryKey; label: string }> = [
  { key: "waiting_for_user", label: "入力待ち" },
  { key: "blocked", label: "問題あり" },
  { key: "active", label: "実行中" },
  { key: "review_required", label: "レビュー待ち" },
  { key: "merge_ready", label: "マージ準備完了" },
];

type AgentFilter = "all" | "unknown" | AgentSummaryKey;
type LaneGitFilter = "all" | "dirty" | "conflict" | "ahead" | "behind";
type GitFilter = LaneGitFilter | "fetch-failure";
type ProjectSort = "priority" | "name" | "latest";
type CardDensity = "comfortable" | "compact";
type GitStatusFailure = { path: string; error: string };
type HomeView = {
  query: string;
  agentFilter: AgentFilter;
  gitFilter: GitFilter;
  sort: ProjectSort;
  favoritesOnly: boolean;
  hideDormant: boolean;
  density: CardDensity;
};

const defaultView: HomeView = {
  query: "",
  agentFilter: "all",
  gitFilter: "all",
  sort: "priority",
  favoritesOnly: false,
  hideDormant: false,
  density: "comfortable",
};

const gitFilters: Array<{ key: Exclude<GitFilter, "all">; label: string }> = [
  { key: "dirty", label: "変更あり" },
  { key: "conflict", label: "競合" },
  { key: "ahead", label: "未push" },
  { key: "behind", label: "未pull" },
  { key: "fetch-failure", label: "fetch失敗" },
];

function relativeTime(iso: string | null | undefined) {
  if (!iso) return "未取得";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "未取得";
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "たった今";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}時間前`;
  if (seconds < 2_592_000) return `${Math.floor(seconds / 86_400)}日前`;
  return `${Math.floor(seconds / 2_592_000)}ヶ月前`;
}

function exactDate(iso: string | null | undefined) {
  if (!iso) return "未取得";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "未取得" : date.toLocaleString("ja-JP");
}


function stateClass(state: AgentRunState | null | undefined) {
  return state ? `agent-state-${state.replace(/[^a-z0-9_-]/gi, "-")}` : "agent-state-unknown";
}

function ProjectCard({
  acknowledgements,
  project,
  gitStatusFailures,
  favorite,
  density,
  homeQuery,
  showPath,
  onFavorite,
  onInteractEnd,
  onInteractStart,
}: {
  acknowledgements: Acknowledgements | null;
  project: ProjectSummary;
  gitStatusFailures: GitStatusFailure[] | null;
  favorite: boolean;
  density: CardDensity;
  homeQuery: string;
  showPath: boolean;
  onFavorite: () => void;
  onInteractEnd: () => void;
  onInteractStart: () => void;
}) {
  const target = project.main_path;
  const href = target === null ? null : `/project?path=${encodeURIComponent(target)}&tab=flow&range=7d${homeQuery ? `&home=${encodeURIComponent(homeQuery)}` : ""}`;
  const workHref = (filter: LaneGitFilter, query: string | null = null) => {
    if (target === null) return null;
    const params = new URLSearchParams({ path: target, tab: "lanes", range: "current" });
    if (filter !== "all") params.set("laneFilter", filter);
    if (query !== null) params.set("laneQuery", query);
    if (homeQuery) params.set("home", homeQuery);
    return `/project?${params}`;
  };
  const state = project.agent_state;
  const [selectedStatus, setSelectedStatus] = useState<AgentSummaryKey | null>(null);
  const agentListId = useId();
  const selectedCount = selectedStatus === null ? null : agentCount(project, selectedStatus);
  const expandedStatus = selectedCount !== null && selectedCount > 0 ? selectedStatus : null;
  const topTasks = topAgentTasks(project.agent_tasks, 3);
  const tasks = expandedStatus === null
    ? topTasks
    : project.agent_tasks?.filter((task) => agentTaskState(task) === expandedStatus);
  const latestAgent = project.latest_agent_event;
  const latestGit = project.latest_event;
  const maxRemainder = Math.max(0, (project.agent_tasks?.length ?? 0) - topTasks.length);
  const hasAttention = project.git.conflict > 0 || project.git.dirty > 0 || project.git.behind > 0 || project.git.ahead > 0 || state === "blocked";
  const unknownKeys = unknownAgentSummaryKeys(project);
  const unknownLabels = unknownKeys.map((key) => AGENT_SUMMARY_LABELS[key as keyof typeof AGENT_SUMMARY_LABELS] || key).join("・");
  const completedCount = agentCount(project, "completed");
  const hasAgentCounts = summaryCards.some(({ key }) => agentCount(project, key) !== null) || completedCount !== null;
  return (
    <article
      className={`project-card${hasAttention ? " project-card-attention" : ""}`}
      data-density={density}
      tabIndex={-1}
      aria-label={project.name}
      onFocusCapture={onInteractStart}
      onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onInteractEnd(); }}
      onPointerEnter={onInteractStart}
      onPointerLeave={onInteractEnd}
    >
      <div className="project-card-topline">
        <span title={state === "merge_ready" ? "agentによる準備完了の報告です。実際のマージ可否を保証しません。" : undefined} className={`agent-state-badge ${stateClass(state)}`}>{agentStateLabel(state)}</span>
        <span className="project-lane-count">{project.lane_count === null ? "ブランチ数 未取得" : `${project.lane_count} ブランチ`}</span>
      </div>
      <div className="project-card-heading">
        <div className="project-card-title-wrap">
          <h3>{href ? <Link href={href} prefetch={false}>{project.name}</Link> : project.name}</h3>
          <code title={remoteLabel(project.remote, project.remote_status)}>{remoteLabel(project.remote, project.remote_status)}</code>
          {showPath && <code className="project-card-location" title={target ?? undefined}>{target === null ? "作業パス未取得" : target}</code>}
        </div>
        <div className="project-card-actions">
          <button
            type="button"
            className="project-favorite"
            aria-label={favorite ? `${project.name}のお気に入りを解除` : `${project.name}をお気に入りに追加`}
            aria-pressed={favorite}
            title={favorite ? "お気に入りを解除" : "お気に入りに追加"}
            onClick={onFavorite}
          >
            <span aria-hidden="true">{favorite ? "★" : "☆"}</span>
          </button>
          {href ? <Link data-project-open className="open-project" href={href} prefetch={false} aria-label={`${project.name} の詳細を開く`}>開く <span aria-hidden="true">↗</span></Link> : <span className="no-checkout">作業パス未取得</span>}
        </div>
      </div>
      {hasAgentCounts && <div className="project-card-agent-counts" aria-label="ブランチの作業状況件数">
        {summaryCards.map(({ key, label }) => {
          const count = agentCount(project, key);
          if (count === null) return null;
          if (count > 0 && AGENT_DECISION_STATUSES.includes(key)) {
            const isOpen = expandedStatus === key;
            return <button key={key} type="button" aria-controls={agentListId} aria-expanded={isOpen} onClick={() => setSelectedStatus(isOpen ? null : key)}>
              <strong>{formatAgentCount(count)}</strong> {label} <span aria-hidden="true">{isOpen ? "▴" : "▾"}</span>
            </button>;
          }
          return <span key={key}><strong>{formatAgentCount(count)}</strong> {label}</span>;
        })}
        {completedCount !== null && <span><strong>{formatAgentCount(completedCount)}</strong> 完了</span>}
      </div>}
      {(expandedStatus !== null || topTasks.length > 0) && <div id={agentListId} className={`project-card-agent-list${expandedStatus !== null ? " project-card-agent-list-expanded" : ""}`} aria-label={expandedStatus === null ? "上位ブランチの作業状況" : `${AGENT_SUMMARY_LABELS[expandedStatus]}のブランチ`}>
        {tasks?.map((task) => {
          const taskState = agentTaskState(task);
          const branchHref = homeBranchHref(target, task.branch, homeQuery);
          return <div className="agent-task-entry" key={agentReportKey(task) || task.branch || task.worktree || "agent-report"}>
            <div className="agent-task-row">
              <span title={taskState === "merge_ready" ? "agentによる準備完了の報告です。実際のマージ可否を保証しません。" : undefined} className={`agent-task-state ${stateClass(taskState)}`}>{agentStateLabel(taskState)}</span>
              <strong>{branchHref ? <Link href={branchHref} prefetch={false}>{task.branch}</Link> : task.branch || "ブランチ未取得"}</strong>
              <span>{task.summary || "報告内容なし"}</span>
            </div>
            {expandedStatus !== null && <AgentDecisionDetails decision={task.decision} />}
          </div>;
        })}
        {expandedStatus === null && maxRemainder > 0 && <span className="agent-remainder">+{maxRemainder} 件</span>}
      </div>}
      <div className="project-card-event"><span className="eyebrow">{latestAgent ? "最新のブランチ報告" : "最新コミット"}</span>{latestAgent ? <><strong title={latestAgent.summary || undefined}>{latestAgent.summary || "報告内容なし"}</strong><span>{latestAgent.branch || "ブランチ未取得"} · {agentStateLabel(agentTaskState(latestAgent))}</span><time dateTime={latestAgent.occurred_at ?? undefined} title={exactDate(latestAgent.occurred_at)}>{relativeTime(latestAgent.occurred_at)} · {exactDate(latestAgent.occurred_at)}</time></> : latestGit ? <><strong title={latestGit.subject}>{latestGit.subject}</strong><time dateTime={latestGit.date} title={exactDate(latestGit.date)}>{relativeTime(latestGit.date)} · {exactDate(latestGit.date)}</time></> : <strong className="unknown">未取得</strong>}</div>
      <div className="project-card-facts" aria-label="Git状態">
        {([
          { key: "dirty", label: "変更あり", color: "warn", title: "未コミットの変更がある作業ディレクトリ数" },
          { key: "conflict", label: "競合", color: "danger", title: "競合がある作業ディレクトリ数" },
          { key: "ahead", label: "↑ 未push", color: "info", title: "追跡先への未pushコミットがある作業ディレクトリ数（ahead > 0）" },
          { key: "behind", label: "↓ 未pull", color: "warn", title: "追跡先からの未pullコミットがある作業ディレクトリ数（behind > 0）" },
        ] as const).map(({ key, label, color, title }) => {
          const count = project.git[key];
          const targetHref = workHref(key);
          return !project.git_status_available ? <span key={key} className="fact" title={title}>{label} <strong>未取得</strong></span> : count > 0 && targetHref ? <Link key={key} className={`fact fact-${color} fact-link`} prefetch={false} href={targetHref} title={`${title}。クリックして該当する作業を表示`} aria-label={`${project.name}の${label} ${count}件の作業を表示`}>{label} <strong>{count}</strong><span className="fact-arrow" aria-hidden="true">↗</span></Link> : <span key={key} className={count > 0 ? `fact fact-${color}` : "fact"} title={title}>{label} <strong>{count}</strong></span>;
        })}
      </div>
      {project.git_status_failed > 0 && <details className="project-card-extra">
        <summary><strong className="fact fact-danger">Git状態の取得失敗 {project.git_status_failed}件</strong>{project.git_status_available ? "（件数は取得できた範囲）" : ""}</summary>
        <p role="status">{gitStatusFailures === null ? "ライブ明細は未取得です（ライブ更新の受信後に表示します）" : `ライブ明細 ${gitStatusFailures.length}件`}</p>
        {gitStatusFailures !== null && <dl>{gitStatusFailures.map(({ path, error }) => (
          <div key={path}><dt>作業パス</dt><dd><code>{path}</code><br />{error}</dd></div>
        ))}</dl>}
      </details>}
      {(() => {
        const task = nextAgentCheck(project, acknowledgements);
        const branch = task ? task.branch : project.next_lane;
        if (!branch) return null;
        const nextHref = task ? homeBranchHref(target, branch, homeQuery) : workHref("all", branch);
        const label = branch === "(detached)" ? "HEAD切り離し（ブランチなし）" : branch;
        return <div className="project-card-footer"><span>次に確認 {nextHref ? <Link href={nextHref} prefetch={false}><strong>{label}</strong><span aria-hidden="true"> →</span></Link> : <strong>{label}</strong>}{task && <span title={task.status === "merge_ready" ? "agentによる準備完了の報告です。実際のマージ可否を保証しません。" : undefined}> · {task.status === "waiting_for_user" ? "agentが入力待ち" : task.status === "blocked" ? "agentが問題を報告" : task.status === "review_required" ? "agentがレビュー待ち" : task.status === "merge_ready" ? "agentがマージ準備完了を報告" : null}</span>}</span><AgentDecisionDetails decision={task?.decision} compact /></div>;
      })()}
      {project.fetch_status?.result === "failure" && <span className="fact fact-danger" role="status">⚠ fetch失敗（{fetchCategoryLabel(project.fetch_status.category)}）</span>}
      <details className="project-card-extra">
        <summary>管理情報 <span>{project.worktree_count} worktree</span></summary>
        <FetchFacts fetchedAt={project.fetched_at} status={project.fetch_status} />
        <dl>
          <div><dt>作業パス</dt><dd><code>{project.main_path ?? "未取得"}</code></dd></div>
          <div><dt>既定との差が最大</dt><dd>{project.largest_difference_lane ?? "未取得"}</dd></div>
          <div><dt>統合済み</dt><dd>{project.git.merged}</dd></div>
          <div><dt title="agent報告・コミット・観測時刻のうち最新の時刻">最新の活動・観測</dt><dd>{projectLatestTime(project) ? relativeTime(new Date(projectLatestTime(project)).toISOString()) : "未取得"}</dd></div>
          {unknownLabels && <div><dt>agent件数未取得</dt><dd>{unknownLabels}</dd></div>}
        </dl>
      </details>
    </article>
  );
}

function SkeletonGrid() {
  return (
    <div className="home-skeleton-grid" aria-label="プロジェクトを読み込み中" role="status">
      {["one", "two", "three"].map((key) => <div className="home-skeleton-card" aria-hidden="true" key={key}><span className="home-skeleton-line" /><span className="home-skeleton-line" /><span className="home-skeleton-line" /></div>)}
    </div>
  );
}

export default function Page() {
  useProjectsLiveUpdates();
  const { repos, scanning, fetching, connected, projectSummaries: projects, projectsLoading: loading, projectsCachedAt, projectsError: error, refreshProjects } = useRepoStream();
  const [hasLoadedEmptyList, setHasLoadedEmptyList] = useState(false);
  useEffect(() => {
    if (!loading && error === null && projects.length === 0) setHasLoadedEmptyList(true);
  }, [loading, error, projects.length]);
  const hasPreviousProjects = projectsCachedAt !== null || projects.length > 0 || hasLoadedEmptyList;
  const projectsUnavailable = !hasPreviousProjects && (loading || error !== null);
  const projectsUnavailableLabel = loading ? "取得中…" : "取得失敗";
  const showingPreviousProjects = hasPreviousProjects && (projectsCachedAt !== null || error !== null);
  const previousLabel = showingPreviousProjects ? "前回取得 · " : "";
  const gitStatusFailuresByProject = useMemo(() => {
    const failures = new Map<string, GitStatusFailure[]>();
    for (const { common_dir, path, error } of repos.values()) {
      if (!error) continue;
      const projectFailures = failures.get(common_dir);
      if (projectFailures === undefined) failures.set(common_dir, [{ path, error }]);
      else projectFailures.push({ path, error });
    }
    return failures;
  }, [repos]);
  const [displayOrder, setDisplayOrder] = useState<string[]>([]);
  const [deferredOrder, setDeferredOrder] = useState<string[] | null>(null);
  const [interactionId, setInteractionId] = useState<string | null>(null);
  const [view, setView] = useState<HomeView>(defaultView);
  const [invalidUrlParams, setInvalidUrlParams] = useState<string[]>([]);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [favoritesReady, setFavoritesReady] = useState(false);
  const [savedViews, setSavedViews] = useState<Array<{ name: string; view: HomeView }>>([]);
  const [savedViewsReady, setSavedViewsReady] = useState(false);
  const [savedViewsIssue, setSavedViewsIssue] = useState<string | null>(null);
  const [viewName, setViewName] = useState("");
  useEffect(() => {
    try {
      const parsed = parseSavedViews(window.localStorage.getItem(SAVED_VIEWS_STORAGE_KEY));
      if (parsed === null) {
        setSavedViewsIssue("保存した表示条件の形式が正しくありません。");
        return;
      }
      setSavedViews(parsed as Array<{ name: string; view: HomeView }>);
      setSavedViewsReady(true);
    } catch {
      setSavedViewsIssue("保存した表示条件を読み込めません。");
    }
  }, []);
  const persistViews = (next: Array<{ name: string; view: HomeView }>) => {
    try {
      window.localStorage.setItem(SAVED_VIEWS_STORAGE_KEY, JSON.stringify(next));
      setSavedViews(next);
      setSavedViewsIssue(null);
      setViewName("");
    } catch {
      setSavedViewsIssue("表示条件の変更を保存できませんでした。保存済みの条件は変更していません。");
    }
  };
  const [favoritesStorageIssue, setFavoritesStorageIssue] = useState<"read" | "format" | "write" | "reset" | null>(null);
  const gridRef = useRef<HTMLElement>(null);
  const [acknowledgements, setAcknowledgements] = useState<Acknowledgements | null>(null);
  useEffect(() => {
    const read = () => {
      try { setAcknowledgements(parseAcknowledgements(localStorage.getItem(ACKNOWLEDGEMENTS_STORAGE_KEY))); }
      catch { setAcknowledgements(null); }
    };
    read();
    window.addEventListener("storage", read);
    window.addEventListener("gitdash-acknowledgements-changed", read);
    return () => {
      window.removeEventListener("storage", read);
      window.removeEventListener("gitdash-acknowledgements-changed", read);
    };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const cards = Array.from(gridRef.current?.querySelectorAll<HTMLElement>(".project-card") ?? []);
      const card = target.closest<HTMLElement>(".project-card");
      const action = homeCardKeyAction(event, {
        editing: target.isContentEditable || Boolean(target.closest("input, textarea, select, [role='textbox']")),
        dialogOpen: Boolean(document.querySelector("dialog[open]")),
        cardFocused: card !== null && cards.includes(card),
        interactive: target !== card,
      });
      if (action === null) return;
      if (action === "open") {
        const link = card?.querySelector<HTMLAnchorElement>("[data-project-open]");
        if (link) { event.preventDefault(); link.click(); }
        return;
      }
      const index = homeCardIndex(action, card === null ? -1 : cards.indexOf(card), cards.length);
      if (index === null) return;
      event.preventDefault();
      cards[index].focus({ preventScroll: true });
      cards[index].scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.defaultPrevented || document.querySelector("dialog[open]") || target.isContentEditable || target.closest("input, textarea, select")) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const syncFromUrl = () => {
      const parsed = parseHomeUrl(window.location.search);
      if (parsed.view !== null) setView(parsed.view as HomeView);
      setInvalidUrlParams(parsed.invalidParams);
    };
    syncFromUrl();
    const onPopState = () => syncFromUrl();
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const nextIds = sortProjects(projects).map((project) => project.id);
    if (!nextIds.length) { setDisplayOrder([]); return; }
    setDisplayOrder((current) => {
      const initial = current.length ? current : nextIds;
      if (!interactionId) return deferredOrder ? current : nextIds;
      const result = deferProjectOrder(initial, nextIds, true);
      if (result.deferred) setDeferredOrder(nextIds);
      return result.order;
    });
  }, [deferredOrder, interactionId, projects]);

  useEffect(() => {
    let raw: string | null;
    try {
      raw = window.localStorage.getItem(FAVORITES_STORAGE_KEY);
    } catch {
      setFavoritesStorageIssue("read");
      return;
    }
    const parsed = parseFavoriteIds(raw);
    if (parsed === null) {
      setFavoritesStorageIssue("format");
      return;
    }
    setFavorites(new Set(parsed));
    setFavoritesReady(true);
  }, []);

  useEffect(() => {
    if (!favoritesReady || favoritesStorageIssue) return;
    try {
      window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify([...favorites].sort()));
    } catch {
      setFavoritesStorageIssue("write");
      setFavoritesReady(false);
    }
  }, [favorites, favoritesReady, favoritesStorageIssue]);

  const duplicateNames = useMemo(() => {
    const names = new Set<string>();
    const duplicates = new Set<string>();
    for (const project of projects) {
      if (names.has(project.name)) duplicates.add(project.name);
      names.add(project.name);
    }
    return duplicates;
  }, [projects]);
  const orderedByPriority = useMemo(() => {
    const byId = new Map(projects.map((project) => [project.id, project]));
    return displayOrder.map((id) => byId.get(id)).filter((project): project is ProjectSummary => Boolean(project));
  }, [displayOrder, projects]);
  const ordered = useMemo(() => view.sort === "priority" ? orderedByPriority : sortHomeProjects(projects, view.sort), [orderedByPriority, projects, view.sort]);
  const dormantIds = useMemo(() => new Set(projects.filter((project) => isDormantProject(project, acknowledgements, Date.now())).map((project) => project.id)), [projects, acknowledgements]);
  const visible = useMemo(() => invalidUrlParams.length > 0 ? [] : ordered.filter((project) => projectMatchesView(project, view, favorites) && (!view.hideDormant || !dormantIds.has(project.id))), [dormantIds, favorites, invalidUrlParams.length, ordered, view]);
  const oldActiveReports = countOldActiveReports(projects, Date.now());
  const totals = useMemo(() => aggregateAgentCounts(projects), [projects]);
  useEffect(() => {
    document.title = `${previousLabel}${homeDocumentTitle(totals.waiting_for_user)}`;
    return () => { document.title = "gitdash"; };
  }, [totals.waiting_for_user, previousLabel]);
  const unknownProjectTotal = useMemo(() => countProjectsWithUnknownAgentCounts(projects), [projects]);
  const gitTotals = useMemo(() => ({ conflicts: projects.reduce((sum, item) => sum + item.git.conflict, 0), dirty: projects.reduce((sum, item) => sum + item.git.dirty, 0), failed: projects.reduce((sum, item) => sum + item.git_status_failed, 0), available: projects.some((item) => item.git_status_available), lanes: projects.every((item) => item.lane_count !== null) ? projects.reduce((sum, item) => sum + (item.lane_count ?? 0), 0) : null }), [projects]);
  const hasActiveFilters = Boolean(view.query.trim() || view.agentFilter !== "all" || view.gitFilter !== "all" || view.favoritesOnly || view.hideDormant || invalidUrlParams.length);
  const startInteraction = (id?: string) => setInteractionId(id || "grid");
  const finishInteraction = () => setInteractionId(null);
  const applyOrder = () => { if (deferredOrder) { setDisplayOrder(deferredOrder); setDeferredOrder(null); } };
  const applyView = (changes: Partial<HomeView>, historyMode: "push" | "replace" = "push") => {
    const next = { ...view, ...changes };
    setView(next);
    setInvalidUrlParams([]);
    const search = homeSearch(next);
    const nextHref = `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`;
    const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextHref !== currentHref) {
      if (historyMode === "replace") window.history.replaceState({}, "", nextHref);
      else window.history.pushState({}, "", nextHref);
    }
  };
  const resetView = () => applyView({ query: "", agentFilter: "all", gitFilter: "all", favoritesOnly: false, hideDormant: false, ...(invalidUrlParams.length ? defaultView : {}) });
  const homeQuery = homeSearch(view);
  const reposWithOperations = useMemo(
    () => [...repos.values()].flatMap((repo) => repo.operations?.length ? [{ repo, operations: repo.operations }] : []),
    [repos],
  );
  const gitProjectCounts = useMemo(() => Object.fromEntries(gitFilters.map(({ key }) => [key, projects.filter((project) => matchesGitFilter(project, key)).length])), [projects]);
  const toggleFavorite = (projectId: string) => {
    setFavorites((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };
  const resetFavoriteStorage = () => {
    try {
      window.localStorage.removeItem(FAVORITES_STORAGE_KEY);
      setFavorites(new Set());
      setFavoritesStorageIssue(null);
      setFavoritesReady(true);
    } catch {
      setFavoritesStorageIssue("reset");
    }
  };
  const retry = refreshProjects;

  const agentSummaryQuiet = projects.length > 0 && !projects.some((project) => summaryCards.some(({ key }) => { const count = agentCount(project, key); return count !== null && count > 0; }));
  const agentSummary = (<div className="home-summary" aria-label="ブランチの作業状況サマリー">
        {invalidUrlParams.length > 0 ? <span className="filter-unavailable">URL条件を確認してから一覧を表示します。</span> : <>
          {summaryCards.filter(({ key }) => loading || error !== null || totals[key] !== null).map(({ key, label }) => <button type="button" className="home-summary-card" data-empty={totals[key] === 0} key={key} aria-label={`${label}のプロジェクトを表示`} aria-pressed={view.agentFilter === key} onClick={() => applyView({ agentFilter: view.agentFilter === key ? "all" : key })}><strong className={totals[key] === null ? "count-unknown" : undefined}>{projectsUnavailable ? projectsUnavailableLabel : formatAgentCount(totals[key])}</strong><span>{label}</span>{key === "active" && projects.length > 0 && <small>うち24時間以上更新なし {oldActiveReports}件</small>}</button>)}
          <button type="button" className="home-summary-card" aria-label="agent報告がないプロジェクトを表示" aria-pressed={view.agentFilter === "unknown"} onClick={() => applyView({ agentFilter: view.agentFilter === "unknown" ? "all" : "unknown" })}><strong>{projectsUnavailable ? projectsUnavailableLabel : unknownProjectTotal}</strong><span>agent報告なし</span></button>
        </>}
        <p className="home-summary-note">集計とタブタイトルの入力待ち件数は、確認済みを含む最新の報告件数です。</p>
      </div>);

  return (
    <main className="home-shell" id="main-content" tabIndex={-1}>
      <header className="home-header"><div className="brand-lockup"><span className="brand-mark" aria-hidden="true">gd</span><div><p className="brand-kicker">Git リポジトリダッシュボード</p><h1>gitdash</h1></div></div><div className="home-header-tools"><ProjectSwitcher currentPath={null} homeQuery={homeQuery} /><ThemeControl /><ShortcutHelp /><RescanControl scanning={scanning} /><div className="connection-state" aria-live="polite"><span className={`connection-dot${connected ? " is-on" : ""}`} aria-hidden="true" />{connected ? "ライブ更新" : "再接続中"}{scanning && <span> · 走査中</span>}</div></div></header>
      {fetchProgressLabel(fetching) !== null && <p className="fetch-progress" role="status">{fetchProgressLabel(fetching)}</p>}
      <section className="home-intro" aria-labelledby="home-title"><div><p className="eyebrow">WORKSPACE OVERVIEW</p><h2 id="home-title">プロジェクト一覧<span className="project-total">{projectsUnavailable ? projectsUnavailableLabel : `${previousLabel}${projects.length}`}</span></h2><p className="intro-copy">変更を見つけて、次の作業へ。ブランチとworktreeをひとつの場所で。</p></div>{agentSummaryQuiet ? <details className="agent-summary-disclosure" open={view.agentFilter !== "all"}><summary>ブランチの作業状況{unknownProjectTotal > 0 && ` · ${unknownProjectTotal}プロジェクトでagent報告なし`}<span>件数の内訳・絞り込み</span></summary>{agentSummary}</details> : agentSummary}</section>
      {reposWithOperations.length > 0 && <section aria-labelledby="home-git-operations-title">
        <h2 id="home-git-operations-title">Git操作の途中</h2>
        <ul>
          {reposWithOperations.map(({ repo: { path, common_dir, branch, detached }, operations }) => {
            const projectPath = common_dir.replace(/\/+$/, "");
            const projectName = projectPath === "" ? "/" : projectPath.slice(projectPath.lastIndexOf("/") + 1);
            const branchLabel = detached ? "detached HEAD" : branch == null ? "ブランチ未取得" : branch;
            const lane = detached ? `worktree:${path}` : branch == null ? null : `branch:${branch}`;
            const label = `${projectName} / ${branchLabel} · ${operations.map(({ kind }) => kind).join("、")}`;
            const params = new URLSearchParams({ path, tab: "lanes", range: "current" });
            if (homeQuery) params.set("home", homeQuery);
            if (lane !== null) params.set("lane", lane);
            return <li key={path} title={path}>
              {lane === null ? label : <Link className="open-project" href={`/project?${params}`} prefetch={false}>{label}</Link>}
            </li>;
          })}
        </ul>
      </section>}
      {invalidUrlParams.length === 0 && <section className="home-toolbar" aria-label="プロジェクト検索と絞り込み">
        <label className="home-search"><span className="sr-only">プロジェクトを検索</span><span aria-hidden="true">⌕</span><input ref={searchRef} aria-keyshortcuts="/" value={view.query} onChange={(event) => applyView({ query: event.target.value }, "replace")} placeholder="プロジェクト、パス、リモートを検索" type="search" /><kbd aria-hidden="true">/</kbd></label>
        <label>並び順<select value={view.sort} onChange={(event) => applyView({ sort: event.target.value as ProjectSort })} aria-label="プロジェクトの並び順"><option value="priority">優先度</option><option value="name">名前</option><option value="latest">最新更新</option></select></label>
        <div role="group" aria-label="Git状態で絞り込み"><button type="button" aria-pressed={view.gitFilter === "all"} onClick={() => applyView({ gitFilter: "all" })}>すべて</button>{gitFilters.map(({ key, label }) => <button type="button" key={key} aria-pressed={view.gitFilter === key} onClick={() => applyView({ gitFilter: view.gitFilter === key ? "all" : key })}>{label}<span className="filter-count">{projectsUnavailable ? "—" : gitProjectCounts[key]}</span></button>)}</div>
        <button type="button" aria-pressed={view.favoritesOnly} onClick={() => applyView({ favoritesOnly: !view.favoritesOnly })}>{view.favoritesOnly ? "★ お気に入りのみ" : "☆ お気に入り"}</button>
        <button type="button" aria-pressed={view.hideDormant} title="最新コミットが30日以上前で、変更・未push・未確認の判断待ち・実行中がないプロジェクト" onClick={() => applyView({ hideDormant: !view.hideDormant })}>休眠プロジェクトを隠す<span className="filter-count">{projectsUnavailable ? "—" : `${dormantIds.size}件${view.hideDormant ? "を非表示" : ""}`}</span></button>
        <div role="group" aria-label="カード密度"><button type="button" aria-pressed={view.density === "comfortable"} onClick={() => applyView({ density: "comfortable" })}>ゆったり</button><button type="button" aria-pressed={view.density === "compact"} onClick={() => applyView({ density: "compact" })}>コンパクト</button></div>
        <span className="toolbar-note">{projectsUnavailable ? (loading ? "Git件数を取得中…" : "Git件数の取得失敗") : <>{previousLabel}{gitTotals.lanes === null ? "ブランチ数は一部未取得" : `${gitTotals.lanes} ブランチ`} · {gitTotals.failed === 0 ? `${gitTotals.dirty} 作業ディレクトリに変更` : `${gitTotals.available ? `取得できた範囲で ${gitTotals.dirty} 作業ディレクトリに変更` : "変更件数は未取得"} · Git状態の取得失敗 ${gitTotals.failed}件`}</>}</span>
      </section>}
      <section className="home-saved-views" aria-label="表示条件の保存">
        <p>名前を付けた表示条件は、このブラウザ内（localStorage）に保存します。件数・検索結果は保存しません。</p>
        <form onSubmit={(event) => {
          event.preventDefault();
          const name = viewName.trim();
          if (!savedViewsReady || invalidUrlParams.length > 0 || !name || savedViews.some((entry) => entry.name === name)) return;
          persistViews([...savedViews, { name, view: { ...view } }]);
        }}>
          <label>表示条件の名前<input value={viewName} onChange={(event) => setViewName(event.target.value)} /></label>
          <button type="submit" disabled={!savedViewsReady || invalidUrlParams.length > 0 || !viewName.trim() || savedViews.some((entry) => entry.name === viewName.trim())}>現在の条件を保存</button>
          {savedViews.some((entry) => entry.name === viewName.trim()) && <span>同じ名前が保存されています。別の名前を入力してください。</span>}
        </form>
        {savedViews.length > 0 && <ul>{savedViews.map((entry) => <li key={entry.name}><span>{entry.name}</span><button type="button" aria-label={entry.name + "の表示条件を適用"} onClick={() => applyView(entry.view)}>適用</button><button type="button" aria-label={entry.name + "の表示条件を削除"} onClick={() => persistViews(savedViews.filter((item) => item.name !== entry.name))}>削除</button></li>)}</ul>}
        {savedViewsIssue && <div role="alert"><span>{savedViewsIssue}</span>{!savedViewsReady && <button type="button" onClick={() => {
          try {
            window.localStorage.removeItem(SAVED_VIEWS_STORAGE_KEY);
            setSavedViews([]);
            setSavedViewsReady(true);
            setSavedViewsIssue(null);
          } catch {
            setSavedViewsIssue("表示条件の保存データを削除できませんでした。");
          }
        }}>保存データを削除して表示条件を初期化</button>}</div>}
      </section>
      {hasActiveFilters && invalidUrlParams.length === 0 && <div className="active-filters" aria-label="選択中の検索条件">
        <span>絞り込み</span>
        {view.hideDormant && <button type="button" onClick={() => applyView({ hideDormant: false })}>休眠を非表示<span aria-hidden="true">×</span></button>}
        {view.query.trim() && <button type="button" onClick={() => applyView({ query: "" })} aria-label="検索キーワードを解除">検索: {view.query}<span aria-hidden="true">×</span></button>}
        {view.agentFilter !== "all" && <button type="button" onClick={() => applyView({ agentFilter: "all" })} aria-label="ブランチ作業状況の絞り込みを解除">{view.agentFilter === "unknown" ? "agent報告なし" : AGENT_SUMMARY_LABELS[view.agentFilter]}<span aria-hidden="true">×</span></button>}
        {view.gitFilter !== "all" && <button type="button" onClick={() => applyView({ gitFilter: "all" })} aria-label="Gitの絞り込みを解除">{gitFilters.find((item) => item.key === view.gitFilter)?.label}<span aria-hidden="true">×</span></button>}
        {view.favoritesOnly && <button type="button" onClick={() => applyView({ favoritesOnly: false })} aria-label="お気に入りの絞り込みを解除">★ お気に入り<span aria-hidden="true">×</span></button>}
      </div>}
      {favoritesStorageIssue && <div className="home-results" role="alert"><span>{favoritesStorageIssue === "read" ? "お気に入りの保存データを読み込めません。" : favoritesStorageIssue === "format" ? "お気に入りの保存データの形式が正しくありません。" : favoritesStorageIssue === "write" ? "お気に入りの変更を保存できませんでした。この画面には反映されていますが、再読み込み後は失われる可能性があります。" : "お気に入りの保存データを削除できませんでした。"} 保存データを削除すると、この画面のお気に入りもすべて解除されます。</span><button type="button" onClick={resetFavoriteStorage}>保存データを削除してお気に入りを解除</button></div>}
      {invalidUrlParams.length > 0 && <div className="home-state home-state-error" role="alert"><span>URLの絞り込み条件を認識できませんでした: {invalidUrlParams.join("、")}</span><button type="button" onClick={resetView}>条件をリセット</button></div>}
      {invalidUrlParams.length === 0 && deferredOrder && view.sort === "priority" && <div className="order-update" role="status"><span>優先度の並び順に更新があります</span><button type="button" onClick={applyOrder}>並び順を更新</button></div>}
      {invalidUrlParams.length === 0 && <div className="home-results" role="status" aria-live="polite"><span>{projectsUnavailable ? (loading ? "プロジェクトを読み込み中…" : "プロジェクト一覧の取得失敗") : `${previousLabel}${visible.length} / ${projects.length} プロジェクトを表示中`}</span>{hasActiveFilters && <button type="button" onClick={resetView}>条件をリセット</button>}</div>}
      {invalidUrlParams.length === 0 && view.gitFilter === "fetch-failure" && <FetchFailureBreakdown projects={visible} />}
      {invalidUrlParams.length === 0 && <WorkspaceExport projects={visible} view={view} disabled={loading || error !== null} />}
      {projectsCachedAt !== null && <div className="home-state" role="status"><strong>前回取得したデータを表示中（{Math.max(0, Math.floor((Date.now() - projectsCachedAt) / 60000))}分前）{loading ? "・最新を取得中…" : ""}</strong><span>一覧・件数・タブタイトルは前回取得時点の情報です。ファビコンの入力待ち件数は最新取得まで表示しません。</span></div>}
      {invalidUrlParams.length === 0 && projectsUnavailable && loading && <SkeletonGrid />}
      {error && <div className="home-state home-state-error" role="alert"><strong>{hasPreviousProjects ? "最新情報を取得できませんでした。前回取得した一覧を表示しています。" : "プロジェクト情報を取得できませんでした。"}</strong><span className="sr-only">{error}</span><button type="button" onClick={retry}>再試行</button></div>}
      {invalidUrlParams.length === 0 && !loading && !error && visible.length === 0 && <div className="home-state home-empty"><h3>該当するプロジェクトがありません</h3><p>{hasActiveFilters ? "現在の条件に一致するプロジェクトはありません。条件をリセットして一覧を確認できます。" : "登録されたプロジェクトはありません。"}</p>{hasActiveFilters && <button type="button" onClick={resetView}>条件をリセット</button>}</div>}
      {invalidUrlParams.length === 0 && <section ref={gridRef} className={`project-grid${view.density === "compact" ? " project-grid-compact" : ""}`} aria-label="プロジェクト一覧">{visible.map((project) => <ProjectCard acknowledgements={acknowledgements} key={project.id} showPath={duplicateNames.has(project.name)} density={view.density} homeQuery={homeQuery} favorite={favorites.has(project.id)} onFavorite={() => toggleFavorite(project.id)} onInteractEnd={finishInteraction} onInteractStart={() => startInteraction(project.id)} project={project} gitStatusFailures={gitStatusFailuresByProject.get(project.id) ?? null} />)}</section>}
      <GitGuide path={null} />
      <details className="git-reading-guide"><summary>Git状態の見方</summary><div>
        <p><strong>変更あり</strong> 作業ディレクトリに未コミットの変更があります。<code>git status</code> で確認できます。</p>
        <p><strong>競合</strong> 同じ箇所への変更が衝突しています。対象ファイルを確認し、競合を解消します。</p>
        <p><strong>↑ 未push（ahead）</strong> ローカルにだけあるコミットを持つ作業ディレクトリです。<code>git log @{'{u}'}..HEAD</code> で確認できます。</p>
        <p><strong>↓ 未pull（behind）</strong> 追跡先にだけあるコミットを持つ作業ディレクトリです。<code>git log HEAD..@{'{u}'}</code> で確認できます。</p>
        <p>Git状態は最終取得時点の情報です。ターミナル操作後は「再走査」で更新できます。追跡先の状態は最終fetch時点です。追跡先がないブランチは未push・未pullの集計対象外です。カードの数値は、それぞれの状態に当てはまる作業ディレクトリ数です。</p>
      </div></details>
      <p className="home-footnote"><span className="legend-line" aria-hidden="true" /> agent の明示状態・最新報告を優先。Git の件数は補助情報です。</p>
    </main>
  );
}

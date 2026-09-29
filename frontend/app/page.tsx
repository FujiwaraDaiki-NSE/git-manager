"use client";

import Link from "next/link";
import ProjectSwitcher from "./project-switcher";
import ThemeControl from "./theme-control";
import RescanControl from "./rescan-control";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AGENT_SUMMARY_LABELS,
  FAVORITES_STORAGE_KEY,
  aggregateAgentCounts,
  agentCount,
  countProjectsWithUnknownAgentCounts,
  formatAgentCount,
  homeSearch,
  parseFavoriteIds,
  parseHomeUrl,
  projectMatchesView,
  sortHomeProjects,
  unknownAgentSummaryKeys,
} from "./home-overview.mjs";
import { agentReportKey, agentStateLabel, agentTaskState, deferProjectOrder, mergeAgentSnapshot, projectLatestTime, sortProjects, topAgentTasks } from "./agent-overview.mjs";
import { useRepoStream } from "./repo-stream";
import type { AgentRunState, ProjectSummary } from "./types";

type AgentSummaryKey = "waiting_for_user" | "blocked" | "active" | "review_required" | "merge_ready";
const summaryCards: Array<{ key: AgentSummaryKey; label: string }> = [
  { key: "waiting_for_user", label: "入力待ち" },
  { key: "blocked", label: "問題あり" },
  { key: "active", label: "実行中" },
  { key: "review_required", label: "レビュー待ち" },
  { key: "merge_ready", label: "マージ可能" },
];

type AgentFilter = "all" | "unknown" | AgentSummaryKey;
type GitFilter = "all" | "dirty" | "conflict" | "ahead" | "behind";
type ProjectSort = "priority" | "name" | "latest";
type CardDensity = "comfortable" | "compact";
type HomeView = {
  query: string;
  agentFilter: AgentFilter;
  gitFilter: GitFilter;
  sort: ProjectSort;
  favoritesOnly: boolean;
  density: CardDensity;
};

const defaultView: HomeView = {
  query: "",
  agentFilter: "all",
  gitFilter: "all",
  sort: "priority",
  favoritesOnly: false,
  density: "comfortable",
};

const gitFilters: Array<{ key: Exclude<GitFilter, "all">; label: string }> = [
  { key: "dirty", label: "変更あり" },
  { key: "conflict", label: "競合" },
  { key: "ahead", label: "未push" },
  { key: "behind", label: "未pull" },
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

function remoteLabel(remote: string | null) {
  if (!remote) return "リモート未取得";
  const value = remote.trim();
  const scp = !value.includes("://") && value.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  if (scp) return `${scp[1]}/${scp[2].replace(/\.git\/?$/i, "")}`;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return `${url.host}${url.pathname.replace(/\.git\/?$/i, "")}`;
  } catch {
    return value.replace(/\.git\/?$/i, "");
  }
}

function stateClass(state: AgentRunState | null | undefined) {
  return state ? `agent-state-${state.replace(/[^a-z0-9_-]/gi, "-")}` : "agent-state-unknown";
}

function ProjectCard({
  project,
  favorite,
  density,
  homeQuery,
  showPath,
  onFavorite,
  onInteractEnd,
  onInteractStart,
}: {
  project: ProjectSummary;
  favorite: boolean;
  density: CardDensity;
  homeQuery: string;
  showPath: boolean;
  onFavorite: () => void;
  onInteractEnd: () => void;
  onInteractStart: () => void;
}) {
  const target = project.main_path;
  const href = target === null ? null : `/project?path=${encodeURIComponent(target)}&tab=flow&range=current${homeQuery ? `&home=${encodeURIComponent(homeQuery)}` : ""}`;
  const workHref = (filter: GitFilter, query: string | null = null) => {
    if (target === null) return null;
    const params = new URLSearchParams({ path: target, tab: "lanes", range: "current" });
    if (filter !== "all") params.set("laneFilter", filter);
    if (query !== null) params.set("laneQuery", query);
    if (homeQuery) params.set("home", homeQuery);
    return `/project?${params}`;
  };
  const state = project.agent_state;
  const tasks = topAgentTasks(project.agent_tasks, 3);
  const latestAgent = project.latest_agent_event;
  const latestGit = project.latest_event;
  const maxRemainder = Math.max(0, (project.agent_tasks?.length ?? 0) - tasks.length);
  const hasAttention = project.git.conflict > 0 || project.git.dirty > 0 || project.git.behind > 0 || project.git.ahead > 0 || state === "blocked";
  const unknownKeys = unknownAgentSummaryKeys(project);
  const unknownLabels = unknownKeys.map((key) => AGENT_SUMMARY_LABELS[key as keyof typeof AGENT_SUMMARY_LABELS] || key).join("・");
  const completedCount = agentCount(project, "completed");
  const hasAgentCounts = summaryCards.some(({ key }) => agentCount(project, key) !== null) || completedCount !== null;
  return (
    <article
      className={`project-card${hasAttention ? " project-card-attention" : ""}`}
      data-density={density}
      aria-label={project.name}
      onFocusCapture={onInteractStart}
      onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onInteractEnd(); }}
      onPointerEnter={onInteractStart}
      onPointerLeave={onInteractEnd}
    >
      <div className="project-card-topline">
        <span className={`agent-state-badge ${stateClass(state)}`}>{agentStateLabel(state)}</span>
        <span className="project-lane-count">{project.lane_count === null ? "ブランチ数 未取得" : `${project.lane_count} ブランチ`}</span>
      </div>
      <div className="project-card-heading">
        <div className="project-card-title-wrap">
          <h3>{href ? <Link href={href} prefetch={false}>{project.name}</Link> : project.name}</h3>
          <code title={remoteLabel(project.remote)}>{remoteLabel(project.remote)}</code>
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
          {href ? <Link className="open-project" href={href} prefetch={false} aria-label={`${project.name} の詳細を開く`}>開く <span aria-hidden="true">↗</span></Link> : <span className="no-checkout">作業パス未取得</span>}
        </div>
      </div>
      {hasAgentCounts && <div className="project-card-agent-counts" aria-label="ブランチの作業状況件数">
        {summaryCards.map(({ key, label }) => {
          const count = agentCount(project, key);
          return count === null ? null : <span key={key}><strong>{formatAgentCount(count)}</strong> {label}</span>;
        })}
        {completedCount !== null && <span><strong>{formatAgentCount(completedCount)}</strong> 完了</span>}
      </div>}
      {tasks.length > 0 && <div className="project-card-agent-list" aria-label="上位ブランチの作業状況">
        {tasks.length ? tasks.map((task) => { const taskState = agentTaskState(task); return <div className="agent-task-row" key={agentReportKey(task) || task.branch || task.worktree || "agent-report"}><span className={`agent-task-state ${stateClass(taskState)}`}>{agentStateLabel(taskState)}</span><strong>{task.branch || "ブランチ未取得"}</strong><span>{task.summary || "報告内容なし"}</span></div>; }) : <div className="agent-task-row agent-task-unknown"><span className="agent-dot" aria-hidden="true" /><strong>ブランチ状態不明</strong><span>報告未取得</span></div>}
        {maxRemainder > 0 && <span className="agent-remainder">+{maxRemainder} 件</span>}
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
          return count > 0 && targetHref ? <Link key={key} className={`fact fact-${color} fact-link`} prefetch={false} href={targetHref} title={`${title}。クリックして該当する作業を表示`} aria-label={`${project.name}の${label} ${count}件の作業を表示`}>{label} <strong>{count}</strong><span className="fact-arrow" aria-hidden="true">↗</span></Link> : <span key={key} className={count > 0 ? `fact fact-${color}` : "fact"} title={title}>{label} <strong>{count}</strong></span>;
        })}
      </div>
      {project.next_lane && <div className="project-card-footer"><span>次に確認 {workHref("all", project.next_lane) ? <Link href={workHref("all", project.next_lane)!} prefetch={false}><strong>{project.next_lane}</strong><span aria-hidden="true"> →</span></Link> : <strong>{project.next_lane}</strong>}</span></div>}
      <details className="project-card-extra">
        <summary>管理情報 <span>{project.worktree_count} worktree</span></summary>
        <dl>
          <div><dt>作業パス</dt><dd><code>{project.main_path ?? "未取得"}</code></dd></div>
          <div><dt>既定との差が最大</dt><dd>{project.largest_difference_lane ?? "未取得"}</dd></div>
          <div><dt>統合済み</dt><dd>{project.git.merged}</dd></div>
          <div><dt>最終観測</dt><dd>{projectLatestTime(project) ? relativeTime(new Date(projectLatestTime(project)).toISOString()) : "未取得"}</dd></div>
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
  const { repos, scanning, fetching, connected, latestAgentEvent } = useRepoStream();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [displayOrder, setDisplayOrder] = useState<string[]>([]);
  const [deferredOrder, setDeferredOrder] = useState<string[] | null>(null);
  const [interactionId, setInteractionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<HomeView>(defaultView);
  const [invalidUrlParams, setInvalidUrlParams] = useState<string[]>([]);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [favoritesReady, setFavoritesReady] = useState(false);
  const [favoritesStorageIssue, setFavoritesStorageIssue] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || target.isContentEditable || target.closest("input, textarea, select")) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const snapshotKey = useMemo(() => [...repos.values()].map((repo) => `${repo.path}:${repo.checked_at ?? repo.activity ?? 0}`).sort().join("|"), [repos]);

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
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetch("/api/projects", { cache: "no-store", signal: controller.signal }).then(async (response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return (await response.json()) as { projects: ProjectSummary[] }; }).then((value) => {
        if (controller.signal.aborted) return;
        setProjects(value.projects);
        setLoading(false); setError(null);
      }).catch((reason: unknown) => { if (!controller.signal.aborted) { setLoading(false); setError(reason instanceof Error ? reason.message : "unknown error"); } });
    }, snapshotKey ? 120 : 0);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [reloadToken, snapshotKey]);

  useEffect(() => {
    if (!latestAgentEvent) return;
    setProjects((current) => current.map((project) => (
      (latestAgentEvent.project_id && project.id === latestAgentEvent.project_id)
      || project.main_path === latestAgentEvent.worktree
        ? mergeAgentSnapshot(project, latestAgentEvent)
        : project
    )));
  }, [latestAgentEvent]);

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
      setFavoritesStorageIssue(true);
      return;
    }
    const parsed = parseFavoriteIds(raw);
    if (parsed === null) {
      setFavoritesStorageIssue(true);
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
      setFavoritesStorageIssue(true);
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
  const visible = useMemo(() => invalidUrlParams.length > 0 ? [] : ordered.filter((project) => projectMatchesView(project, view, favorites)), [favorites, invalidUrlParams.length, ordered, view]);
  const totals = useMemo(() => aggregateAgentCounts(projects), [projects]);
  const unknownProjectTotal = useMemo(() => countProjectsWithUnknownAgentCounts(projects), [projects]);
  const gitTotals = useMemo(() => ({ conflicts: projects.reduce((sum, item) => sum + item.git.conflict, 0), dirty: projects.reduce((sum, item) => sum + item.git.dirty, 0), lanes: projects.every((item) => item.lane_count !== null) ? projects.reduce((sum, item) => sum + (item.lane_count ?? 0), 0) : null }), [projects]);
  const hasActiveFilters = Boolean(view.query.trim() || view.agentFilter !== "all" || view.gitFilter !== "all" || view.favoritesOnly || invalidUrlParams.length);
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
  const resetView = () => applyView({ query: "", agentFilter: "all", gitFilter: "all", favoritesOnly: false, ...(invalidUrlParams.length ? defaultView : {}) });
  const homeQuery = homeSearch(view);
  const gitProjectCounts = useMemo(() => Object.fromEntries(gitFilters.map(({ key }) => [key, projects.filter((project) => project.git[key] > 0).length])), [projects]);
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
      setFavoritesStorageIssue(false);
      setFavoritesReady(true);
    } catch {
      setFavoritesStorageIssue(true);
    }
  };
  const retry = () => { setError(null); setLoading(true); setReloadToken((value) => value + 1); };

  const agentSummaryQuiet = projects.length > 0 && !projects.some((project) => summaryCards.some(({ key }) => { const count = agentCount(project, key); return count !== null && count > 0; }));
  const agentSummary = (<div className="home-summary" aria-label="ブランチの作業状況サマリー">
        {invalidUrlParams.length > 0 ? <span className="filter-unavailable">URL条件を確認してから一覧を表示します。</span> : <>
          {summaryCards.map(({ key, label }) => <button type="button" className="home-summary-card" key={key} aria-label={`${label}のプロジェクトを表示`} aria-pressed={view.agentFilter === key} onClick={() => applyView({ agentFilter: view.agentFilter === key ? "all" : key })}><strong className={totals[key] === null ? "count-unknown" : undefined}>{loading && !projects.length ? "…" : totals[key] === null ? "未取得" : formatAgentCount(totals[key])}</strong><span>{label}</span></button>)}
          <button type="button" className="home-summary-card" aria-label="ブランチ作業状況の件数不明プロジェクトを表示" aria-pressed={view.agentFilter === "unknown"} onClick={() => applyView({ agentFilter: view.agentFilter === "unknown" ? "all" : "unknown" })}><strong>{loading && !projects.length ? "…" : unknownProjectTotal}</strong><span>件数未取得</span></button>
        </>}
      </div>);

  return (
    <main className="home-shell" id="main-content" tabIndex={-1}>
      <header className="home-header"><div className="brand-lockup"><span className="brand-mark" aria-hidden="true">gd</span><div><p className="brand-kicker">Git リポジトリダッシュボード</p><h1>gitdash</h1></div></div><div className="home-header-tools"><ProjectSwitcher currentPath={null} homeQuery={homeQuery} /><ThemeControl /><RescanControl scanning={scanning} /><div className="connection-state" aria-live="polite"><span className={`connection-dot${connected ? " is-on" : ""}`} aria-hidden="true" />{connected ? "ライブ更新" : "再接続中"}{scanning && <span> · 走査中</span>}{fetching && <span> · fetch 中</span>}</div></div></header>
      <section className="home-intro" aria-labelledby="home-title"><div><p className="eyebrow">WORKSPACE OVERVIEW</p><h2 id="home-title">プロジェクト一覧<span className="project-total">{loading && !projects.length ? "…" : projects.length}</span></h2><p className="intro-copy">変更を見つけて、次の作業へ。ブランチとworktreeをひとつの場所で。</p></div>{agentSummaryQuiet ? <details className="agent-summary-disclosure" open={view.agentFilter !== "all"}><summary>ブランチの作業状況{unknownProjectTotal > 0 && ` · ${unknownProjectTotal}プロジェクトで件数未取得`}<span>件数の内訳・絞り込み</span></summary>{agentSummary}</details> : agentSummary}</section>
      {invalidUrlParams.length === 0 && <section className="home-toolbar" aria-label="プロジェクト検索と絞り込み">
        <label className="home-search"><span className="sr-only">プロジェクトを検索</span><span aria-hidden="true">⌕</span><input ref={searchRef} aria-keyshortcuts="/" value={view.query} onChange={(event) => applyView({ query: event.target.value }, "replace")} placeholder="プロジェクト、パス、リモートを検索" type="search" /><kbd aria-hidden="true">/</kbd></label>
        <label>並び順<select value={view.sort} onChange={(event) => applyView({ sort: event.target.value as ProjectSort })} aria-label="プロジェクトの並び順"><option value="priority">優先度</option><option value="name">名前</option><option value="latest">最新更新</option></select></label>
        <div role="group" aria-label="Git状態で絞り込み"><button type="button" aria-pressed={view.gitFilter === "all"} onClick={() => applyView({ gitFilter: "all" })}>すべて</button>{gitFilters.map(({ key, label }) => <button type="button" key={key} aria-pressed={view.gitFilter === key} onClick={() => applyView({ gitFilter: view.gitFilter === key ? "all" : key })}>{label}<span className="filter-count">{loading && !projects.length ? "…" : gitProjectCounts[key]}</span></button>)}</div>
        <button type="button" aria-pressed={view.favoritesOnly} onClick={() => applyView({ favoritesOnly: !view.favoritesOnly })}>{view.favoritesOnly ? "★ お気に入りのみ" : "☆ お気に入り"}</button>
        <div role="group" aria-label="カード密度"><button type="button" aria-pressed={view.density === "comfortable"} onClick={() => applyView({ density: "comfortable" })}>ゆったり</button><button type="button" aria-pressed={view.density === "compact"} onClick={() => applyView({ density: "compact" })}>コンパクト</button></div>
        <span className="toolbar-note">{gitTotals.lanes === null ? "ブランチ数は一部未取得" : `${gitTotals.lanes} ブランチ`} · {gitTotals.dirty} 作業ディレクトリに変更</span>
      </section>}
      {hasActiveFilters && invalidUrlParams.length === 0 && <div className="active-filters" aria-label="選択中の検索条件">
        <span>絞り込み</span>
        {view.query.trim() && <button type="button" onClick={() => applyView({ query: "" })} aria-label="検索キーワードを解除">検索: {view.query}<span aria-hidden="true">×</span></button>}
        {view.agentFilter !== "all" && <button type="button" onClick={() => applyView({ agentFilter: "all" })} aria-label="ブランチ作業状況の絞り込みを解除">{view.agentFilter === "unknown" ? "件数未取得" : AGENT_SUMMARY_LABELS[view.agentFilter]}<span aria-hidden="true">×</span></button>}
        {view.gitFilter !== "all" && <button type="button" onClick={() => applyView({ gitFilter: "all" })} aria-label="Gitの絞り込みを解除">{gitFilters.find((item) => item.key === view.gitFilter)?.label}<span aria-hidden="true">×</span></button>}
        {view.favoritesOnly && <button type="button" onClick={() => applyView({ favoritesOnly: false })} aria-label="お気に入りの絞り込みを解除">★ お気に入り<span aria-hidden="true">×</span></button>}
      </div>}
      {favoritesStorageIssue && <div className="home-results" role="alert"><span>お気に入りの保存データを読み込めません。お気に入り機能を再設定できます。</span><button type="button" onClick={resetFavoriteStorage}>保存を再設定</button></div>}
      {invalidUrlParams.length > 0 && <div className="home-state home-state-error" role="alert"><span>URLの絞り込み条件を認識できませんでした: {invalidUrlParams.join("、")}</span><button type="button" onClick={resetView}>条件をリセット</button></div>}
      {invalidUrlParams.length === 0 && deferredOrder && view.sort === "priority" && <div className="order-update" role="status"><span>優先度の並び順に更新があります</span><button type="button" onClick={applyOrder}>並び順を更新</button></div>}
      {invalidUrlParams.length === 0 && <div className="home-results" role="status" aria-live="polite"><span>{loading && !projects.length ? "プロジェクトを読み込み中…" : `${visible.length} / ${projects.length} プロジェクトを表示中`}</span>{hasActiveFilters && <button type="button" onClick={resetView}>条件をリセット</button>}</div>}
      {invalidUrlParams.length === 0 && loading && projects.length === 0 && <SkeletonGrid />}
      {error && <div className="home-state home-state-error" role="alert"><strong>{projects.length ? "最新情報を取得できませんでした。前回取得した一覧を表示しています。" : "プロジェクト情報を取得できませんでした。"}</strong><span className="sr-only">{error}</span><button type="button" onClick={retry}>再試行</button></div>}
      {invalidUrlParams.length === 0 && !loading && !error && visible.length === 0 && <div className="home-state home-empty"><h3>該当するプロジェクトがありません</h3><p>{hasActiveFilters ? "現在の条件に一致するプロジェクトはありません。条件をリセットして一覧を確認できます。" : "登録されたプロジェクトはありません。"}</p>{hasActiveFilters && <button type="button" onClick={resetView}>条件をリセット</button>}</div>}
      {invalidUrlParams.length === 0 && <section className={`project-grid${view.density === "compact" ? " project-grid-compact" : ""}`} aria-label="プロジェクト一覧">{visible.map((project) => <ProjectCard key={project.id} showPath={duplicateNames.has(project.name)} density={view.density} homeQuery={homeQuery} favorite={favorites.has(project.id)} onFavorite={() => toggleFavorite(project.id)} onInteractEnd={finishInteraction} onInteractStart={() => startInteraction(project.id)} project={project} />)}</section>}
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

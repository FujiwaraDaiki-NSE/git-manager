"use client";

import PatchView from "./patch-view";
import CommitFiles from "./commit-files";
import GitGuide from "./git-guide";
import BranchTimeline from "./branch-timeline";

import Link from "next/link";
import { homeReturnHref } from "./home-overview.mjs";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import CopyButton from "./copy-button";
import ProjectSwitcher from "./project-switcher";
import ThemeControl from "./theme-control";
import RescanControl from "./rescan-control";
import RepoDetail, { type DetailTab } from "./repo-detail";
import { agentReportKey, agentStateLabel, agentTaskState, isExplicitAgentStatus, laneMatchesAgentEvent, mergeAgentSnapshot, projectMatchesAgentEvent } from "./agent-overview.mjs";
import { parseProjectUrl, shouldFoldMergedLane, updateProjectUrl } from "./project-flow.mjs";
import { activityMatchesSearch, compareActivityEvents, laneMatchesFilter, laneMatchesSearch, normalizedSearchQuery, sortWorkLanes } from "./project-search.mjs";
import { useRepoStream } from "./repo-stream";
import type {
  CommitDetail,
  ProjectBranchCommit,
  ProjectEvent,
  ProjectLane,
  ProjectResponse,
  Repo,
  AgentTask,
} from "./types";

type ControlTab = "flow" | "lanes" | "activity" | "info";
type TimeRange = "current" | "24h" | "7d" | "all";
type ActivityFilter = "all" | "commit" | "edit" | "test" | "review" | "input";
type ActivityOrder = "newest" | "oldest";
type LaneFilter = "all" | "dirty" | "conflict" | "ahead" | "behind" | "worktree";
type LaneOrder = "name" | "latest" | "attention";
type LoadState = "idle" | "loading" | "ready" | "error";
type CopyStatus = "idle" | "success" | "error";
type ProjectUrlChanges = Record<string, string | number | boolean | null | undefined>;

const tabs: { id: ControlTab; label: string; short: string }[] = [
  { id: "flow", label: "ブランチ", short: "BRANCHES" },
  { id: "lanes", label: "作業一覧", short: "LANES" },
  { id: "activity", label: "アクティビティ", short: "ACTIVITY" },
  { id: "info", label: "プロジェクト情報", short: "INFO" },
];

const ranges: { id: TimeRange; label: string }[] = [
  { id: "current", label: "各ブランチの先端" },
  { id: "24h", label: "24時間" },
  { id: "7d", label: "7日" },
  { id: "all", label: "全期間" },
];

const activityFilters: { id: ActivityFilter; label: string }[] = [
  { id: "all", label: "すべて" },
  { id: "commit", label: "コミット" },
  { id: "edit", label: "編集" },
  { id: "test", label: "テスト" },
  { id: "review", label: "レビュー" },
  { id: "input", label: "入力待ち" },
];

async function writeClipboard(value: string) {
  if (typeof navigator === "undefined" || !navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function relativeTime(iso: string | null | undefined) {
  if (!iso) return "未取得";
  const value = new Date(iso).getTime();
  if (Number.isNaN(value)) return "未取得";
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
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

function shortHash(hash: string | null | undefined) {
  return hash ? hash.slice(0, 8) : "未取得";
}

function laneLabel(lane: ProjectLane) {
  return lane.historical ? lane.name : lane.branch || "detached HEAD";
}

function laneMergeSummary(lane: ProjectLane) {
  const outgoing = lane.merge_sources.map((relation) => `→ ${relation.target_branch ?? "不明"}`);
  const incoming = lane.merge_targets.map((relation) => `${relation.source_branch ?? "不明"} →`);
  return [...outgoing, ...incoming].join(" / ") || "合流関係なし / 不明";
}

function laneState(lane: ProjectLane, defaultBranch: string | null = null) {
  if (lane.historical) return "履歴";
  if (lane.conflict === true) return "競合";
  if (lane.dirty === true) return "変更あり";
  if (lane.worktree_state === "prunable") return "作業先なし";
  if (lane.worktree_state === "locked") return "ロック中";
  if (defaultBranch && lane.branch === defaultBranch) return "既定";
  if (lane.merged === true) return "統合済み";
  if (lane.unborn === true) return "初回コミット前";
  if (lane.detached === true) return "ブランチ未接続";
  if (lane.error) return "Git情報未取得";
  if (lane.dirty === false) return "変更なし";
  return "作業状態 未取得";
}

function laneStateClass(lane: ProjectLane, defaultBranch: string | null = null) {
  if (lane.conflict === true) return "lane-state-danger";
  if (lane.dirty === true || lane.worktree_state === "prunable" || lane.worktree_state === "locked")
    return "lane-state-warn";
  if (defaultBranch && lane.branch === defaultBranch) return "lane-state-ok";
  if (lane.merged === true || lane.dirty === null) return "lane-state-muted";
  if (lane.error) return "lane-state-warn";
  return "lane-state-ok";
}

function isFoldedMerged(lane: ProjectLane) {
  // A branch tip can be reachable from HEAD while its linked worktree still
  // contains uncommitted/conflicting Git facts. Prunable worktrees are the
  // exception: Git has explicitly reported that their checkout is gone, so
  // they belong in the completed/default folded group even if is_worktree is
  // still true in the stale snapshot.
  return shouldFoldMergedLane(lane);
}

function currentLaneAgent(lane: ProjectLane) {
  return lane.agent;
}

function upstreamLabel(lane: ProjectLane) {
  if (!lane.upstream) return "upstream 未取得";
  if (lane.upstream_ahead === null || lane.upstream_behind === null) {
    return `upstream ${lane.upstream} · push 状態未取得`;
  }
  return `追跡先 ${lane.upstream} · ahead ${lane.upstream_ahead} · behind ${lane.upstream_behind}`;
}

function agentElapsed(occurredAt: string | null | undefined) {
  if (!occurredAt) return "経過時間 未取得";
  const time = new Date(occurredAt).getTime();
  if (Number.isNaN(time)) return "経過時間 未取得";
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return "経過 1分未満";
  if (seconds < 3600) return `経過 ${Math.floor(seconds / 60)}分`;
  if (seconds < 86400) return `経過 ${Math.floor(seconds / 3600)}時間`;
  return `経過 ${Math.floor(seconds / 86400)}日`;
}

function AgentFact({ task, branch }: { task: AgentTask | null | undefined; branch?: string | null }) {
  if (!task) return <span className="agent-unknown">ブランチ状態不明</span>;
  return (
    <span className="agent-fact">
      <strong>{agentStateLabel(agentTaskState(task))}</strong>
      <span>{branch || task.branch || "ブランチ未取得"}</span>
      <span>{task.phase ? agentStateLabel(task.phase) : "工程未取得"}</span>
      <span>{task.summary || "報告内容なし"}</span>
      <time dateTime={task.occurred_at ?? undefined}>{agentElapsed(task.occurred_at)}</time>
      {task.attention && task.attention !== task.status && <em>{agentStateLabel(task.attention)}</em>}
    </span>
  );
}

function valueOrUnknown(value: string | number | null | undefined) {
  return value === null || value === undefined || value === "" ? "未取得" : String(value);
}

function agentCount(project: ProjectResponse, key: keyof ProjectResponse["agent_priority_counts"]) {
  const value = project.agent_priority_counts?.[key];
  return value === null || value === undefined ? "?" : value;
}

function projectFromUrl() {
  return projectFromSearch(typeof window === "undefined" ? "" : window.location.search);
}

function projectFromSearch(search: string) {
  const parsed = parseProjectUrl(search);
  return {
    path: parsed.path,
    tab: parsed.tab as ControlTab,
    range: parsed.range as TimeRange,
    merged: parsed.merged,
    event: parsed.event,
    lane: parsed.lane,
    branchRow: parsed.branchRow,
    at: parsed.at,
    laneQuery: parsed.laneQuery,
    laneFilter: parsed.laneFilter as LaneFilter,
    laneOrder: parsed.laneOrder as LaneOrder,
    activityQuery: parsed.activityQuery,
    activityFilter: parsed.activityFilter as ActivityFilter,
    activityOrder: parsed.activityOrder as ActivityOrder,
    invalidParams: parsed.invalidParams,

  };
}

function useProjectUrl() {
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const [state, setState] = useState(projectFromUrl);
  useEffect(() => {
    const sync = () => setState(projectFromUrl());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  useEffect(() => {
    // Next's soft navigation updates searchParams without dispatching a
    // browser popstate event.  Subscribe to the router-owned URL as well as
    // the native history event so a Link always supplies its path on mount.
    setState(projectFromSearch(search));
  }, [search]);
  const update = useCallback((changes: ProjectUrlChanges, historyMode: "push" | "replace" = "push") => {
    const nextHref = updateProjectUrl(window.location.href, changes);
    // Keep tab/range/selection navigable with browser back/forward. Slider
    // drags are the high-frequency exception and replace only the observation
    // point until the user chooses another URL-level control.
    const replace = historyMode === "replace" || (Object.keys(changes).length === 1 && Object.prototype.hasOwnProperty.call(changes, "at"));
    window.history[replace ? "replaceState" : "pushState"]({}, "", nextHref);
    setState(projectFromSearch(new URL(nextHref, window.location.origin).search));
  }, []);
  return { state, update };
}

const laneFilters: { id: LaneFilter; label: string }[] = [
  { id: "all", label: "すべて" },
  { id: "dirty", label: "変更あり" },
  { id: "conflict", label: "競合" },
  { id: "ahead", label: "未push" },
  { id: "behind", label: "未pull" },
  { id: "worktree", label: "worktree" },
];

function commitEventForBranch(project: ProjectResponse, hash: string, branch: string | null, lane: ProjectLane | null, metadata: ProjectBranchCommit | null = null): ProjectEvent {
  const existing = project.events.find((event) => event.type === "commit" && event.commit_hash === hash);
  return {
    ...(existing ?? {}),
    id: existing?.id ?? `branch-row:${hash}`,
    occurred_at: metadata?.date ?? existing?.occurred_at ?? null,
    observed_at: existing?.observed_at ?? project.observed_at,
    type: "commit",
    source: "git",
    project_id: project.id,
    worktree: lane?.path ?? null,
    branch,
    lane_id: lane?.id ?? null,
    lane_names: branch ? [branch] : lane?.branch ? [lane.branch] : [],
    commit_hash: hash,
    subject: metadata?.subject ?? existing?.subject ?? null,
    author: metadata?.author ?? existing?.author ?? null,
    parents: metadata?.parents ?? existing?.parents ?? [],
    stats: existing?.stats ?? null,
  };
}

function LaneSummary({ lane, defaultBranch }: { lane: ProjectLane; defaultBranch: string | null }) {
  return <><span className={`lane-state ${laneStateClass(lane, defaultBranch)}`}>{laneState(lane, defaultBranch)}</span><AgentFact branch={lane.branch} task={currentLaneAgent(lane)} /></>;
}

function WorkLanes({
  searchQuery, onSearch, filter, onFilter, order, onOrder,
  project,
  selectedLane,
  onSelectLane,
  onOpenGit,
  showMerged,
  onShowMergedChange,
}: {
  searchQuery: string; onSearch: (query: string) => void; filter: LaneFilter; onFilter: (filter: LaneFilter) => void; order: LaneOrder; onOrder: (order: LaneOrder) => void;
  project: ProjectResponse;
  selectedLane: string | null;
  onSelectLane: (lane: ProjectLane) => void;
  onOpenGit: (lane: ProjectLane) => void;
  showMerged: boolean;
  onShowMergedChange: (value: boolean) => void;
}) {
  const normalizedQuery = normalizedSearchQuery(searchQuery);
  const relationLaneIds = useMemo(() => new Set(project.merge_relations.flatMap((relation) => (
    [relation.source_lane_id, relation.target_lane_id].filter((id): id is string => id !== null)
  ))), [project.merge_relations]);
  const visibleLanes = useMemo(
    () => project.lanes.filter((lane) => showMerged || relationLaneIds.has(lane.id) || lane.branch === project.default_branch || !isFoldedMerged(lane)),
    [project.lanes, relationLaneIds, showMerged, project.default_branch],
  );
  const lanes = useMemo(
    () => sortWorkLanes(visibleLanes.filter((lane) => laneMatchesSearch(lane, normalizedQuery) && laneMatchesFilter(lane, filter)), order),
    [filter, order, normalizedQuery, visibleLanes],
  );
  const mergedCount = project.lanes.filter((lane) => lane.branch !== project.default_branch && !relationLaneIds.has(lane.id) && isFoldedMerged(lane)).length;
  return (
    <section className="lanes-section" aria-labelledby="lanes-title">
      <div className="section-heading-row">
        <div>

          <h3 id="lanes-title">作業一覧</h3>
          <p className="section-copy">ブランチごとの状態と、次に確認したいことをまとめています。Git状態は取得時点の情報です。ターミナル操作後は「再走査」で更新できます。</p>
        </div>
        {mergedCount > 0 && <button className="subtle-button" type="button" onClick={() => onShowMergedChange(!showMerged)}>{showMerged ? "統合済みを折り畳む" : `統合済み・完了を表示 (${mergedCount})`}</button>}
      </div>
      <div className="project-search-toolbar" role="search" aria-label="作業レーンを検索">
        <label>
          <span>検索</span>
          <input aria-label="作業レーンを検索" type="search" value={searchQuery} onChange={(event) => onSearch(event.target.value)} placeholder="ブランチ・パス・名前" />
        </label>
        <button className="subtle-button" type="button" disabled={!searchQuery} onClick={() => onSearch("")}>クリア</button>
        <label>並び順<select aria-label="作業一覧の並び順" value={order} onChange={(event) => onOrder(event.target.value as LaneOrder)}><option value="name">名前</option><option value="attention">要確認順</option><option value="latest">最新コミット順</option></select></label>
        <span role="status">{lanes.length} / {visibleLanes.length} 件</span>
      </div>
      <div className="lane-filters" role="group" aria-label="作業の状態で絞り込み">{laneFilters.map((item) => <button className="filter-button" type="button" key={item.id} aria-pressed={filter === item.id} onClick={() => onFilter(item.id)}>{item.label}<span>{visibleLanes.filter((lane) => laneMatchesFilter(lane, item.id)).length}</span></button>)}</div>
      <div className="lane-table-wrap">
        <table className="lane-table">
          <thead>
            <tr><th scope="col">作業</th><th scope="col">Git状態 / ブランチ作業</th><th scope="col">最終活動</th><th scope="col">既定ブランチとの差</th><th scope="col">最新メッセージ</th><th scope="col">合流関係</th><th scope="col">次の工程 / 注意</th><th scope="col" aria-label="操作" /></tr>
          </thead>
          <tbody id="project-lane-results">
            {lanes.map((lane) => (
              <tr className={selectedLane === lane.id ? "is-selected" : ""} key={lane.id}>
                <td data-label="作業">
                  <button className="lane-name-button" type="button" onClick={() => onSelectLane(lane)}>
                    <strong>{laneLabel(lane)}</strong>
                    <code>{shortHash(lane.head)}</code>
                    <span title={lane.path ?? undefined}>{lane.path ?? "作業ディレクトリなし"}</span>
                  </button>
                </td>
                <td data-label="Git状態 / ブランチ作業"><LaneSummary defaultBranch={project.default_branch} lane={lane} /></td>
                <td data-label="最終コミット">
                  <time dateTime={lane.last_commit?.date ?? undefined} title={exactDate(lane.last_commit?.date)}>{relativeTime(lane.last_commit?.date)}</time>
                  <span className="table-subvalue">{exactDate(lane.last_commit?.date)}</span>
                </td>
                <td className="mono-cell" data-label="既定ブランチとの差">{lane.default_ahead === null || lane.default_behind === null ? "未取得" : `ahead ${lane.default_ahead} · behind ${lane.default_behind}`}</td>
                <td className="lane-message" data-label="最新メッセージ"><span title={lane.last_commit?.subject}>{lane.unborn ? "まだコミットがありません" : lane.last_commit?.subject ?? "コミット未取得"}</span>{currentLaneAgent(lane)?.summary && <small>報告: {currentLaneAgent(lane)?.summary}</small>}</td>
                <td className="unknown-cell" data-label="合流関係">{laneMergeSummary(lane)}</td>
                <td className="unknown-cell" data-label="次の工程 / 注意">{lane.next_phase || currentLaneAgent(lane)?.attention || "未取得"}</td>
                <td data-label="操作"><button className="table-action" type="button" disabled={!lane.path} title={!lane.path ? "このブランチには作業ディレクトリがありません" : undefined} onClick={() => onOpenGit(lane)}>Git詳細</button>{!lane.path && <small className="no-checkout">作業ディレクトリなし</small>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {lanes.length === 0 && <div className="empty-flow">{normalizedQuery ? "検索に一致する作業レーンはありません。" : "この条件に一致する作業レーンはありません。"}{(normalizedQuery || filter !== "all") && <button className="subtle-button" type="button" onClick={() => { onSearch(""); onFilter("all"); }}>絞り込みを解除</button>}</div>}
    </section>
  );
}

function ActivityBranches({ names }: { names: string[] }) {
  const [expanded, setExpanded] = useState(false);
  return <details className="activity-branches" onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary>関連ブランチ {names.length} 件</summary>
    {expanded && <div>{names.map((name) => <code key={name}>{name}</code>)}</div>}
  </details>;
}

function activityAgentLabel(event: { kind?: string | null; status?: string | null; run_state?: string | null }) {
  if (event.kind === "lifecycle") return `ライフサイクル · ${event.run_state || "状態未取得"}`;
  return event.status ? agentStateLabel(event.status) : "ブランチ状態不明";
}

function ActivityView({
  searchQuery, onSearch, order, onOrder,
  project,
  filter,
  onFilter,
  onSelect,
}: {
  searchQuery: string; onSearch: (query: string) => void; order: ActivityOrder; onOrder: (order: ActivityOrder) => void;
  project: ProjectResponse;
  filter: ActivityFilter;
  onFilter: (filter: ActivityFilter) => void;
  onSelect: (event: ProjectEvent) => void;
}) {
  const normalizedQuery = normalizedSearchQuery(searchQuery);
  const unifiedEvents = useMemo(() => project.events.map((event) => ({
    ...event,
    commit_hash: event.commit_hash ?? null,
    subject: event.source === "agent" ? event.summary ?? null : event.subject ?? null,
    author: event.source === "agent" ? event.agent_id ?? null : event.author ?? null,
    agent_state: event.source === "agent" ? event.status ?? null : null,
    task_id: event.source === "agent" ? event.task_id ?? null : null,
    status: event.source === "agent" ? event.status ?? null : null,
    kind: event.source === "agent" ? event.kind ?? null : null,
    agent_phase: event.source === "agent" ? event.phase ?? null : null,
    attention: event.source === "agent" ? event.attention ?? null : null,
  })), [project.events]);
  const filterEvents = useMemo(() => unifiedEvents.filter((event) => {
    if (filter === "all") return true;
    if (filter === "commit") return event.type === "commit";
    if (filter === "edit") return event.status === "implementing" || event.agent_phase === "implementing";
    if (filter === "test") return event.status === "testing" || event.agent_phase === "testing";
    if (filter === "review") return event.status === "review_required" || event.status === "reviewing" || event.agent_state === "review_required" || event.agent_state === "reviewing";
    return event.status === "waiting_for_user" || event.agent_state === "waiting_for_user";
  }), [filter, unifiedEvents]);
  const events = useMemo(() => [...filterEvents]
    .filter((event) => activityMatchesSearch(event, normalizedQuery))
    .sort((a, b) => compareActivityEvents(a, b, order)), [filterEvents, normalizedQuery, order]);
  const viewKey = JSON.stringify([project.id, project.range, normalizedQuery, filter, order]);
  const [page, setPage] = useState({ key: viewKey, limit: 100 });
  useEffect(() => { setPage({ key: viewKey, limit: 100 }); }, [viewKey]);
  const limit = page.key === viewKey ? page.limit : 100;
  const shown = events.slice(0, limit);
  const listRef = useRef<HTMLOListElement>(null);
  const nextRowRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (nextRowRef.current === null) return;
    const row = listRef.current?.children[nextRowRef.current] as HTMLElement | undefined;
    nextRowRef.current = null;
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "start" });
  }, [page]);
  const showMore = (nextLimit: number) => {
    nextRowRef.current = shown.length;
    setPage({ key: viewKey, limit: nextLimit });
  };
  return (
    <section className="activity-section" aria-labelledby="activity-title">
      <div className="section-heading-row">
        <div><h3 id="activity-title">アクティビティ</h3><p className="section-copy">このプロジェクトで起きたことを、見やすい順番で確認できます。</p></div>
      </div>
      <div className="project-search-toolbar" role="search" aria-label="アクティビティを検索">
        <label>
          <span>検索</span>
          <input aria-label="アクティビティを検索" type="search" value={searchQuery} onChange={(event) => onSearch(event.target.value)} placeholder="件名・概要・担当者・ブランチ" />
        </label>
        <button className="subtle-button" type="button" disabled={!searchQuery} onClick={() => onSearch("")}>クリア</button>
        <label>
          <span>並び順</span>
          <select aria-label="アクティビティの並び順" value={order} onChange={(event) => onOrder(event.target.value as ActivityOrder)}>
            <option value="newest">新しい順</option>
            <option value="oldest">古い順</option>
          </select>
        </label>
        <span role="status">{events.length} / {filterEvents.length} 件一致{shown.length < events.length ? ` · ${shown.length}件を表示` : ""}</span>
      </div>
      <div className="activity-filters" role="toolbar" aria-label="イベント種別">
        {activityFilters.map((item) => (
          <button className="filter-button" aria-pressed={filter === item.id} type="button" key={item.id} onClick={() => onFilter(item.id)}>
            {item.label}
          </button>
        ))}
      </div>
      {events.length === 0 ? (
        <div className="empty-activity">{normalizedQuery ? "検索に一致するイベントはありません。" : "この条件に一致するイベントはありません。"}{(normalizedQuery || filter !== "all") && <button className="subtle-button" type="button" onClick={() => { onSearch(""); onFilter("all"); }}>絞り込みを解除</button>}</div>
      ) : (
        <ol className="activity-list" ref={listRef}>
          {shown.map((event) => (
            <li key={event.id} tabIndex={-1}>
              <div className="activity-time"><time dateTime={event.occurred_at ?? undefined}>{exactDate(event.occurred_at)}</time><span>{relativeTime(event.occurred_at)}</span></div>
              <span className="activity-source"><i aria-hidden="true" />{event.source === "agent" ? "agent" : event.source} · {event.type === "commit" ? "コミット" : event.source === "agent" ? activityAgentLabel(event) : event.type}</span>
              <div className="activity-content">
                <strong>{event.subject || (event.type === "agent" ? "報告内容なし" : "件名なし")}</strong>
                <span>{event.author ?? "作成者未取得"}{event.kind === "lifecycle" && event.task_id ? ` · セッション ${event.task_id}` : ""}</span>
                {event.lane_names && event.lane_names.length > 3 ? <ActivityBranches names={event.lane_names} /> : <span>{event.lane_names?.length ? event.lane_names.join(" / ") : event.branch ?? "対象ブランチ未取得"}</span>}
                {event.attention && <span className="activity-attention">注意: {agentStateLabel(event.attention)}</span>}
              </div>
              {event.commit_hash && <button className="activity-commit" type="button" onClick={() => onSelect(event)}>{shortHash(event.commit_hash)} 詳細</button>}
            </li>
          ))}
        </ol>
      )}
      {shown.length < events.length && <div className="activity-more"><span>一致する{events.length}件のうち、{shown.length}件を表示しています。検索は取得済みの全件が対象です。</span><button className="secondary-action" type="button" onClick={() => showMore(limit + 100)}>次の{Math.min(100, events.length - shown.length)}件を表示</button><button className="subtle-button" type="button" onClick={() => showMore(events.length)}>全{events.length}件を表示</button></div>}
    </section>
  );
}

function ProjectInfo({ project }: { project: ProjectResponse }) {
  return (
    <section className="info-section" aria-labelledby="info-title">
      <div className="section-heading-row"><div><h3 id="info-title">プロジェクト情報</h3><p className="section-copy">このプロジェクトの基本情報と、今わかっている管理状況です。</p></div></div>
      <div className="info-grid">
        <div className="info-card info-card-wide"><span className="eyebrow">説明</span><p>{project.description || "説明なし"}</p></div>
        <InfoField label="リモート URL" value={project.remote} code />
        <InfoField label="既定ブランチ" value={project.default_branch} code />
        <InfoField label="メインの作業パス" value={project.main_path} code />
        <InfoField label="最終 fetch" value={project.fetched_at ? exactDate(new Date(project.fetched_at * 1000).toISOString()) : null} />
        <InfoField label="ローカルブランチ" value={project.branch_counts.local} />
        <InfoField label="リモートブランチ" value={project.branch_counts.remote} />
        <InfoField label="統合済みブランチ" value={project.maintenance.merged} />
        <InfoField label="削除されたworktree" value={project.maintenance.prunable} />
        <InfoField label="ロック中のworktree" value={project.maintenance.locked} />
        <InfoField label="使用言語" value={project.languages ? project.languages.join(", ") : null} />
        <InfoField label="主要ディレクトリ" value={project.directories ? project.directories.join(", ") : null} />
        <InfoField label="テストコマンド" value={project.test_commands ? project.test_commands.join(" / ") : null} />
        <InfoField label="ブランチの作業状況" value={project.agent_tasks === null ? null : `${project.agent_tasks.length} 件`} />
      </div>
      <div className="info-subsection"><h4>ブランチの作業状況</h4>{project.agent_tasks === null ? <div className="info-unavailable" role="status">ブランチ状態不明（報告未取得）</div> : project.agent_tasks.length ? <div className="related-agent-tasks">{project.agent_tasks.map((task) => <div className="related-agent-task" key={agentReportKey(task) || task.branch || task.worktree || "agent-report"}><div><strong>{task.branch || "ブランチ未取得"}</strong><span>{agentStateLabel(agentTaskState(task))}</span></div><p>{task.summary || "報告内容なし"}</p><time dateTime={task.occurred_at ?? undefined}>{exactDate(task.occurred_at)} · {agentElapsed(task.occurred_at)}</time></div>)}</div> : <div className="info-unavailable" role="status">明示されたブランチ報告はありません。</div>}</div>
      <div className="info-subsection"><h4>worktree 一覧</h4><div className="worktree-records">{project.worktrees.map((item) => <div className="worktree-record" key={item.path}><span className="worktree-shape" aria-hidden="true" /><strong>{item.branch ?? "detached HEAD"}</strong><code title={item.path}>{item.path}</code><CopyButton value={item.path} label={`${item.branch ?? "worktree"} のパスをコピー`} /><span className={`lane-state ${item.state === "prunable" || item.state === "locked" ? "lane-state-warn" : "lane-state-ok"}`}>{item.state ?? "未取得"}</span></div>)}</div></div>
      <div className="info-unavailable" role="status">PR・レビュー・CI の情報は、明示された値のみ表示します。</div>
    </section>
  );
}

function InfoField({ label, value, code = false }: { label: string; value: string | number | null | undefined; code?: boolean }) {
  return <div className="info-field"><span>{label}</span>{code ? <code title={valueOrUnknown(value)}>{valueOrUnknown(value)}</code> : <strong>{valueOrUnknown(value)}</strong>}{code && typeof value === "string" && value.length > 0 && <CopyButton value={value} label={`${label}をコピー`} />}</div>;
}

function LaneDetail({ lane, defaultBranch, onOpenGit }: { lane: ProjectLane; defaultBranch: string | null; onOpenGit: (lane: ProjectLane) => void }) {
  return (
    <div className="selection-content">
      <div className="selection-kicker">作業レーン</div>
      <h3>{laneLabel(lane)}</h3>
      <div className="selection-badges"><span className={`lane-state ${laneStateClass(lane, defaultBranch)}`}>{laneState(lane, defaultBranch)}</span><AgentFact branch={lane.branch} task={currentLaneAgent(lane)} /></div>
      <dl className="selection-list">
        <div><dt>作業パス</dt><dd><code>{lane.path ?? "未取得"}</code>{lane.path && <CopyButton value={lane.path} label="作業パスをコピー" />}</dd></div>
        <div><dt>作業先端</dt><dd><code>{lane.unborn ? "初回コミット前" : lane.head ?? "未取得"}</code></dd></div>
        <div><dt>分岐点 (merge-base)</dt><dd><code>{lane.merge_base ?? "未取得"}</code></dd></div>
        <div><dt>最終イベント</dt><dd>{lane.unborn ? "まだコミットがありません" : lane.last_commit?.subject ?? "未取得"}{!lane.unborn && <small>{exactDate(lane.last_commit?.date)}</small>}</dd></div>
        <div><dt>既定ブランチとの差</dt><dd>{lane.default_ahead === null || lane.default_behind === null ? "未取得" : `ahead ${lane.default_ahead} · behind ${lane.default_behind}`}</dd></div>
        <div><dt>追跡先との差</dt><dd>{upstreamLabel(lane)}</dd></div>
        <div><dt>ブランチの作業状況</dt><dd>{agentStateLabel(agentTaskState(currentLaneAgent(lane)))}</dd></div>
        <div><dt>このブランチからの合流</dt><dd>{lane.merge_sources.length ? lane.merge_sources.map((relation) => `${relation.target_branch ?? "不明"} (${shortHash(relation.commit_hash)})`).join(" / ") : "なし / 不明"}</dd></div>
        <div><dt>このブランチへの合流</dt><dd>{lane.merge_targets.length ? lane.merge_targets.map((relation) => `${relation.source_branch ?? "不明"} (${shortHash(relation.commit_hash)})`).join(" / ") : "なし / 不明"}</dd></div>
        <div><dt>次の工程 / 注意</dt><dd>{lane.next_phase || (currentLaneAgent(lane)?.attention ? agentStateLabel(currentLaneAgent(lane)?.attention) : null) || "未取得"}</dd></div>
      </dl>
      <details className="flow-help selection-help">
        <summary>Git状態と比較先の見方</summary>
        <p>「変更なし」は作業ディレクトリに未コミットの変更がない状態です。追跡先にまだ送っていないコミットがある場合もあります。</p>
        <p><code>ahead</code> は比較先にない、このブランチのコミット数です。<code>behind</code> はこのブランチにない、比較先のコミット数です。</p>
        <p>「既定ブランチとの差」と「追跡先との差」は比較する相手が異なることがあります。追跡先がリモートブランチなら、ahead は未push、behind は未pullの目安です。リモートの情報は直近のfetch時点のものです。</p>
      </details>
      {lane.next_command && <div className="selection-command"><span>Git 次コマンド</span><code>{lane.next_command.command}</code><CopyButton value={lane.next_command.command} label="コマンドをコピー" /><small>{lane.next_command.reason}</small></div>}
      <button className="primary-action" type="button" disabled={!lane.path} onClick={() => onOpenGit(lane)}>Git 詳細を開く</button>{!lane.path && <p className="no-checkout">このブランチには作業ディレクトリがないため、Git状態の詳細は表示できません。</p>}
    </div>
  );
}

function CommitDetail({
  project,
  event,
  lane,
  onOpenGit,
}: {
  project: ProjectResponse;
  event: ProjectEvent;
  lane: ProjectLane | null;
  onOpenGit: (lane: ProjectLane) => void;
}) {
  const hash = event.commit_hash;
  const path = project.main_path;
  const [state, setState] = useState<LoadState>("loading");
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  useEffect(() => {
    if (!hash || !path) {
      setState("error");
      return;
    }
    const controller = new AbortController();
    setState("loading");
    setDetail(null);
    const timer = window.setTimeout(() => {
      void fetch(`/api/repo/commit?path=${encodeURIComponent(path)}&hash=${encodeURIComponent(hash)}`, { cache: "no-store", signal: controller.signal })
        .then(async (response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return (await response.json()) as CommitDetail; })
        .then((value) => { if (controller.signal.aborted) return; setDetail(value); setState("ready"); })
        .catch((reason: unknown) => { if (controller.signal.aborted) return; setState("error"); });
    }, 150);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [hash, path, retryToken]);
  return (
    <div className="selection-content">
      <div className="selection-kicker">Git コミット</div>
      <h3>{detail?.subject ?? event.subject ?? "コミット詳細"}</h3>
      <div className="selection-commit-meta"><code>{hash ?? "未取得"}</code>{hash && <CopyButton value={hash} label="コミットIDをコピー" />}<span>{event.author ?? "author 未取得"}</span><time dateTime={event.occurred_at ?? undefined}>{exactDate(event.occurred_at)}</time></div>
      {state === "loading" && <div className="selection-loading" role="status">完全なコミット詳細を取得中…</div>}
      {state === "error" && <div className="selection-error" role="alert">コミット詳細を取得できませんでした。<button className="subtle-button" type="button" onClick={() => setRetryToken((value) => value + 1)}>再試行</button></div>}
      {state === "ready" && detail && <>
        <CommitFiles key={detail.hash} files={detail.files} downloadName={`${detail.hash}-files.tsv`} />
        <PatchView key={detail.hash} patch={detail.patch} />
        {detail.patch_truncated && <p className="inline-note" role="status">差分が大きいため、一部を省略しています。全体は <code>git show {hash}</code> で確認できます。</p>}
      </>}
      {lane?.path && <button className="secondary-action" type="button" onClick={() => onOpenGit(lane)}>このレーンの Git 詳細</button>}
    </div>
  );
}

function dialogFocusables(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  ));
}

type DialogEntry = { root: HTMLElement; onClose: () => void };
const dialogStack: DialogEntry[] = [];

function useDialogKeyboard(
  rootRef: React.RefObject<HTMLElement>,
  closeRef: React.RefObject<HTMLElement>,
  onClose: () => void,
  modal = true,
) {
  useEffect(() => {
    if (!modal) return;
    const root = rootRef.current;
    if (!root) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const entry: DialogEntry = { root, onClose };
    dialogStack.push(entry);
    // The selection becomes modal at the mobile breakpoint, potentially
    // after Git details have opened. These layers follow DOM order, not the
    // order in which resize effects registered their keyboard handlers.
    dialogStack.sort((a, b) => a.root.compareDocumentPosition(b.root) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    const frame = window.requestAnimationFrame(() => {
      if (dialogStack.at(-1) === entry && !document.querySelector("dialog[open]")) closeRef.current?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      // Nested Git details share the document listener. Only the topmost
      // dialog may consume Escape or trap Tab; lower selection state and its
      // URL remain intact until the nested dialog is closed.
      if (dialogStack.at(-1) !== entry || document.querySelector("dialog[open]")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !rootRef.current) return;
      const focusables = dialogFocusables(rootRef.current);
      if (!focusables.length) {
        event.preventDefault();
        closeRef.current?.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown, true);
      const wasTop = dialogStack.at(-1) === entry;
      const index = dialogStack.indexOf(entry);
      if (index >= 0) dialogStack.splice(index, 1);
      if (wasTop && previous?.isConnected && !rootRef.current?.contains(previous)) previous.focus();
    };
  }, [closeRef, onClose, rootRef, modal]);
}

function SelectionPane({
  project,
  selectedHash,
  selectedLane,
  selectedEvent,
  onClose,
  onOpenGit,
}: {
  project: ProjectResponse;
  selectedHash: string | null;
  selectedLane: string | null;
  selectedEvent: ProjectEvent | null;
  onClose: () => void;
  onOpenGit: (lane: ProjectLane) => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [modal, setModal] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1199px)");
    const sync = () => setModal(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  useDialogKeyboard(panelRef, closeRef, onClose, modal);
  useEffect(() => {
    // Keep the original trigger across responsive changes between a side panel
    // and a modal. Recapturing on resize can point to a disappearing child.
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const lane = project.lanes.find((item) => item.id === selectedLane) ?? null;
  return (
    <aside ref={panelRef} className="control-selection" aria-label="選択詳細" aria-modal={modal ? true : undefined} role={modal ? "dialog" : "complementary"} tabIndex={-1}>
      <div className="selection-head"><span className="selection-title">選択した項目の詳細</span><button ref={closeRef} className="icon-close" type="button" aria-label="詳細を閉じる" onClick={onClose}>×</button></div>
      {selectedEvent && selectedHash ? <CommitDetail event={selectedEvent} lane={lane} onOpenGit={onOpenGit} project={project} /> : lane ? <LaneDetail defaultBranch={project.default_branch} lane={lane} onOpenGit={onOpenGit} /> : <div className="selection-content"><p>選択対象はありません。</p></div>}
    </aside>
  );
}

function LegacyGitModal({
  repo,
  tab,
  copied,
  copyError,
  onClose,
  onCopy,
  onTabChange,
}: {
  repo: Repo;
  tab: DetailTab;
  copied: string | null;
  copyError: string | null;
  onClose: () => void;
  onCopy: (value: string) => void;
  onTabChange: (tab: DetailTab) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useDialogKeyboard(panelRef, closeRef, onClose);
  return (
    <div className="legacy-overlay">
      <div ref={panelRef} className="legacy-panel" role="dialog" aria-modal="true" aria-label="Git詳細" tabIndex={-1}>
        <div className="legacy-panel-head">
          <div><span className="eyebrow">GIT DETAIL</span><strong>{repo.branch ?? repo.name}</strong></div>
          <button ref={closeRef} className="icon-close" type="button" aria-label="Git詳細を閉じる" onClick={onClose}>×</button>
        </div>
        <RepoDetail activeTab={tab} copied={copied} onCopy={onCopy} onTabChange={onTabChange} repo={repo} />
        {copyError && <div className="inline-error" role="alert">{copyError}</div>}
      </div>
    </div>
  );
}

function LegacyUnavailableModal({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useDialogKeyboard(panelRef, closeRef, onClose);
  return (
    <div className="legacy-overlay">
      <div ref={panelRef} className="legacy-panel legacy-unavailable" role="dialog" aria-modal="true" aria-label="Git詳細" tabIndex={-1}>
        <button ref={closeRef} className="icon-close" type="button" aria-label="Git詳細を閉じる" onClick={onClose}>×</button>
        <p>この Git checkout の状態は未取得です。</p>
      </div>
    </div>
  );
}

export default function ProjectControl() {
  const { repos, scanning, connected, latestAgentEvent } = useRepoStream();
  const { state: urlState, update: updateUrl } = useProjectUrl();
  const homeQuery = useSearchParams().get("home");
  const homeHref = homeReturnHref(homeQuery);
  const [project, setProject] = useState<ProjectResponse | null>(null);
  const [projectState, setProjectState] = useState<LoadState>("idle");
  const [projectError, setProjectError] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  // Branch rows filter and page their row-level histories locally. Keep their
  // initial project snapshot at the compact current range; Activity still
  // requests the selected range because it consumes the global event history.
  const projectFetchRange = urlState.tab === "flow" ? "current" : urlState.range;
  const resourceKey = `${urlState.path}|${projectFetchRange}`;
  const invalidUrlKey = urlState.invalidParams.join(",");
  const retryProject = () => setReloadToken((value) => value + 1);
  const { laneQuery, laneFilter, laneOrder, activityQuery, activityFilter, activityOrder } = urlState;
  const setLaneQuery = (value: string) => updateUrl({ laneQuery: value }, "replace");
  const setLaneFilter = (value: LaneFilter) => updateUrl({ laneFilter: value === "all" ? null : value });
  const setLaneOrder = (value: LaneOrder) => updateUrl({ laneOrder: value === "name" ? null : value });
  const setActivityQuery = (value: string) => updateUrl({ activityQuery: value }, "replace");
  const setActivityOrder = (value: ActivityOrder) => updateUrl({ activityOrder: value === "newest" ? null : value });
  const [gitPath, setGitPath] = useState<string | null>(null);
  const [gitTab, setGitTab] = useState<DetailTab>("status");
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [projectUrlCopyState, setProjectUrlCopyState] = useState<CopyStatus>("idle");
  const copyRequestRef = useRef(0);
  const projectUrlCopyRequestRef = useRef(0);
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setShowMerged = useCallback((value: boolean) => updateUrl({ merged: value ? true : null }), [updateUrl]);
  const clearBranchFilters = useCallback((showHistory: boolean) => {
    updateUrl({ laneQuery: null, laneFilter: null, ...(showHistory ? { merged: true } : {}) }, "replace");
    if (window.location.hash) {
      const url = new URL(window.location.href);
      url.hash = "";
      window.history.replaceState({}, "", `${url.pathname}${url.search}`);
    }
  }, [updateUrl]);

  useEffect(() => () => {
    if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
  }, []);

  useEffect(() => {
    setProjectUrlCopyState("idle");
  }, [urlState.at, urlState.branchRow, urlState.event, urlState.lane, urlState.merged, urlState.path, urlState.range, urlState.tab, laneQuery, laneFilter, laneOrder, activityQuery, activityFilter, activityOrder]);

  const projectSnapshotKey = useMemo(() => {
    if (!urlState.path) return "";
    const selected = repos.get(urlState.path);
    const common = selected?.common_dir;
    return [...repos.values()]
      .filter((repo) => repo.path === urlState.path || (common && repo.common_dir === common))
      .map((repo) => `${repo.path}:${repo.checked_at ?? repo.activity ?? 0}:${repo.branch ?? ""}:${repo.worktree_state ?? ""}`)
      .sort()
      .join("|");
  }, [repos, urlState.path]);

  useEffect(() => {
    if (invalidUrlKey) return;
    if (!urlState.path) {
      setProject(null);
      setProjectState("error");
      setProjectError("プロジェクトが指定されていません。一覧からプロジェクトを選択してください。");
      return;
    }
    const controller = new AbortController();
    setProjectState("loading");
    setProjectError(null);
    const projectPath = urlState.path;
    const timer = window.setTimeout(() => {
    void fetch(`/api/project?path=${encodeURIComponent(projectPath)}&range=${encodeURIComponent(projectFetchRange)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error(response.status === 404 ? "指定されたプロジェクトが見つかりません。一覧から選び直してください。" : `サーバーから情報を取得できませんでした（HTTP ${response.status}）。`); return (await response.json()) as ProjectResponse; })
      .then((value) => { if (controller.signal.aborted) return; setProject(value); setLoadedKey(resourceKey); setProjectState("ready"); })
      .catch((reason: unknown) => { if (controller.signal.aborted) return; setProjectState("error"); setProjectError(reason instanceof TypeError ? "サーバーとの通信を確認してから再試行してください。" : reason instanceof Error ? reason.message : "情報の取得に失敗しました。"); });
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [invalidUrlKey, projectFetchRange, projectSnapshotKey, resourceKey, reloadToken, urlState.path]);

  useEffect(() => {
    if (!project || !latestAgentEvent) return;
    if (!projectMatchesAgentEvent(project, latestAgentEvent)) return;
    setProject((current) => {
      if (!current) return current;
      // The summary and detail endpoints use different legacy field names;
      // normalize the already-authoritative detail field before applying one
      // SSE report so recency comparisons do not lose another branch's newer
      // report.
      const normalizedCurrent = { ...current, latest_agent_event: current.agent_latest_event };
      const summary = mergeAgentSnapshot(normalizedCurrent, latestAgentEvent);
      // Lifecycle events are activity history only. mergeAgentSnapshot also
      // rejects stale status snapshots, so a lane/latest report is updated
      // only when the explicit status was accepted for this branch.
      const statusApplied = isExplicitAgentStatus(latestAgentEvent) && summary !== normalizedCurrent;
      const lane = statusApplied ? current.lanes.find((item) => laneMatchesAgentEvent(item, latestAgentEvent)) : null;
      const activity = {
        id: `agent:${latestAgentEvent.event_id}`,
        event_id: latestAgentEvent.event_id,
        sequence: latestAgentEvent.sequence ?? null,
        occurred_at: latestAgentEvent.occurred_at,
        observed_at: latestAgentEvent.observed_at,
        type: "agent",
        source: "agent",
        project_id: latestAgentEvent.project_id ?? current.id,
        worktree: latestAgentEvent.worktree,
        branch: latestAgentEvent.branch,
        lane_id: lane?.id ?? null,
        task_id: latestAgentEvent.task_id,
        agent_id: latestAgentEvent.agent_id,
        kind: latestAgentEvent.kind ?? null,
        status: latestAgentEvent.status ?? null,
        run_state: latestAgentEvent.run_state,
        phase: latestAgentEvent.phase,
        attention: latestAgentEvent.attention,
        outcome: latestAgentEvent.outcome,
        summary: latestAgentEvent.summary,
      } as ProjectEvent;
      return {
        ...current,
        agent_tasks: summary.agent_tasks,
        agent_priority_counts: summary.agent_priority_counts,
        agent_state: summary.agent_state,
        agent_latest_event: statusApplied ? summary.latest_agent_event : current.agent_latest_event,
        agent_events: current.agent_events.some((item) => item.event_id === latestAgentEvent.event_id)
          ? current.agent_events
          : [...current.agent_events, latestAgentEvent],
        events: current.events.some((item) => item.id === activity.id) ? current.events : [...current.events, activity],
        lanes: current.lanes.map((item) => (
          statusApplied && laneMatchesAgentEvent(item, latestAgentEvent)
            ? { ...item, agent: latestAgentEvent }
            : item
        )),
      };
    });
  }, [latestAgentEvent, project?.id]);

  const selectedHash = urlState.event;
  const selectedLane = urlState.lane;
  useEffect(() => {
    if (!selectedHash && !selectedLane && !urlState.branchRow) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || gitPath || document.querySelector("dialog[open]")) return;
      event.preventDefault();
      updateUrl({ event: null, lane: null, branchRow: null });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedHash, selectedLane, updateUrl, gitPath, urlState.branchRow]);
  const selectedEvent = useMemo(() => {
    if (!project || !selectedHash) return null;
    const event = project.events.find((item) => item.commit_hash === selectedHash);
    const branch = urlState.branchRow
      ? project.branch_rows?.find((item) => item.id === urlState.branchRow) ?? null
      : selectedLane
        ? project.branch_rows?.find((item) => item.locals.some((lane) => lane.id === selectedLane)) ?? null
        : project.branch_rows?.find((item) => item.commit_hashes.includes(selectedHash)) ?? null;
    // A row is authoritative for the local context. Never reuse an unrelated
    // lane merely because its branch name or commit hash happens to match.
    const lane = branch
      ? branch.locals.find((item) => item.id === selectedLane) ?? null
      : project.lanes.find((item) => item.id === selectedLane) ?? null;
    const metadata = branch?.tip_commits.find((item) => item.hash === selectedHash)
      ?? branch?.commits.find((item) => item.hash === selectedHash)
      ?? null;
    return event || branch ? commitEventForBranch(project, selectedHash, branch?.name ?? lane?.branch ?? null, lane, metadata) : null;
  }, [project, selectedHash, selectedLane, urlState.branchRow]);
  const copy = useCallback((value: string) => {
    const request = copyRequestRef.current + 1;
    copyRequestRef.current = request;
    if (copyResetTimerRef.current) {
      clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = null;
    }
    setCopied(null);
    setCopyError(null);
    void writeClipboard(value).then((success) => {
      if (request !== copyRequestRef.current) return;
      if (!success) {
        setCopyError("コピーできませんでした。ブラウザのクリップボード機能を利用できません。");
        return;
      }
      setCopied(value);
      copyResetTimerRef.current = setTimeout(() => {
        if (request !== copyRequestRef.current) return;
        setCopied((current) => current === value ? null : current);
        copyResetTimerRef.current = null;
      }, 1500);
    });
  }, []);
  const copyCurrentProjectUrl = useCallback(() => {
    const request = projectUrlCopyRequestRef.current + 1;
    projectUrlCopyRequestRef.current = request;
    setProjectUrlCopyState("idle");
    void writeClipboard(window.location.href).then((success) => {
      if (request !== projectUrlCopyRequestRef.current) return;
      setProjectUrlCopyState(success ? "success" : "error");
    });
  }, []);
  const legacyRepo = gitPath ? repos.get(gitPath) ?? null : null;

  const selectEvent = useCallback((event: ProjectEvent, branchRowId?: string) => {
    const hash = event.commit_hash;
    if (!hash) return;
    // A branch row sets lane_id explicitly. Branch names are not identity:
    // remote-only rows and local branches may share a name, and multiple
    // locals may intentionally track one remote row.
    const lane = event.lane_id ? project?.lanes.find((item) => item.id === event.lane_id) : null;
    updateUrl({ event: hash, lane: lane?.id ?? null, branchRow: branchRowId ?? null });
  }, [project?.lanes, updateUrl]);
  const selectLane = useCallback((lane: ProjectLane) => updateUrl({ lane: lane.id, event: null }), [updateUrl]);
  const openGit = useCallback((lane: ProjectLane) => {
    setCopyError(null);
    if (lane.path) setGitPath(lane.path);

  }, []);
  const closeGit = useCallback(() => {
    setCopyError(null);
    setGitPath(null);
  }, []);
  const closeSelection = useCallback(() => updateUrl({ event: null, lane: null, branchRow: null }), [updateUrl]);
  if (urlState.invalidParams.length) {
    return <main className="control-shell" id="main-content" tabIndex={-1}>
      <Link className="back-link" href={homeHref}>← プロジェクト一覧</Link>
      <div className="control-state control-error" role="alert"><strong>URLの表示条件を認識できませんでした。</strong><span>確認が必要な条件: {urlState.invalidParams.join("、")}</span><button className="subtle-button" type="button" onClick={() => updateUrl(Object.fromEntries(urlState.invalidParams.map((key) => [key, null])))}>認識できない条件を解除</button></div>
    </main>;
  }

  if (!project || loadedKey !== resourceKey) {
    return (
      <main className="control-shell" id="main-content" tabIndex={-1}>
        <header className="control-topbar"><Link className="back-link" href={homeHref}>← プロジェクト一覧</Link><span className="connection-state"><span className={`connection-dot${connected ? " is-on" : ""}`} aria-hidden="true" />{connected ? "ライブ更新" : "再接続中"}</span></header>
        {projectState === "error" ? <div className="control-state control-error" role="alert"><strong>プロジェクト情報を取得できませんでした。</strong><span>{projectError}</span>{urlState.path && <button className="subtle-button" type="button" onClick={retryProject}>再試行</button>}</div> : <div className="control-state" role="status">プロジェクトを読み込み中…</div>}
      </main>
    );
  }

  return (
    <main className="control-shell" id="main-content" tabIndex={-1}>
      <header className="control-topbar">
        <Link className="back-link" href={homeHref}>← プロジェクト一覧</Link>
        <div className="control-status"><span className={`connection-dot${connected ? " is-on" : ""}`} aria-hidden="true" />{connected ? "ライブ更新" : "再接続中"}{projectState === "loading" && " · 情報を更新中"}</div>
        <div className="control-topbar-tools"><ProjectSwitcher currentPath={urlState.path} homeQuery={homeQuery} /><ThemeControl /><RescanControl scanning={scanning} /></div>
      </header>
      {projectState === "error" && <div className="project-refresh-error" role="alert"><span>最新情報を取得できませんでした。前回取得した内容を表示しています。</span><button className="subtle-button" type="button" onClick={retryProject}>再試行</button></div>}
      <section className="control-hero" aria-labelledby="project-title">
        <div className="control-hero-main"><div className="project-identity"><h1 id="project-title">{project.name}</h1><span className="project-baseline">既定 <strong>{project.default_branch ?? "未取得"}</strong></span><span className="project-lane-count">{project.lanes.length} 作業レーン</span><span className="project-url-control"><button aria-describedby={projectUrlCopyState !== "idle" ? "project-url-copy-feedback" : undefined} className="subtle-button project-url-copy" type="button" onClick={copyCurrentProjectUrl}>{projectUrlCopyState === "success" ? "URLをコピーしました" : "この画面のURLをコピー"}</button><span aria-live="polite" className="project-url-feedback" id="project-url-copy-feedback" role={projectUrlCopyState === "error" ? "alert" : projectUrlCopyState === "success" ? "status" : undefined}>{projectUrlCopyState === "success" ? "現在のプロジェクト画面URLをコピーしました。" : projectUrlCopyState === "error" ? "URLをコピーできませんでした。ブラウザのクリップボード機能を利用できません。" : "\u00a0"}</span></span></div><details className="project-context"><summary>プロジェクトの概要・集計</summary><p className="control-description">{project.description || "説明なし"}</p><div className="control-identifiers"><code title={project.remote ?? undefined}>{project.remote ?? "リモート未取得"}</code><span>既定 <strong>{project.default_branch ?? "未取得"}</strong></span><code title={project.main_path}>{project.main_path}</code></div><div className="control-latest-git" aria-label="Git最終イベント"><span className="eyebrow">最新コミット</span>{project.latest_event ? <><strong>{project.latest_event.subject || "(no subject)"}</strong><time dateTime={project.latest_event.occurred_at ?? undefined}>{relativeTime(project.latest_event.occurred_at)} · {exactDate(project.latest_event.occurred_at)}</time><span>Git · コミット · {shortHash(project.latest_event.commit_hash)}</span></> : <span>Git · 最終イベント 未取得</span>}</div>
        <div className="control-metrics" aria-label="プロジェクト集計"><div><strong>{agentCount(project, "waiting_for_user")}</strong><span>入力待ち</span></div><div><strong>{agentCount(project, "blocked")}</strong><span>問題あり</span></div><div><strong>{agentCount(project, "active")}</strong><span>実行中</span></div><div><strong>{agentCount(project, "review_required")}</strong><span>レビュー待ち</span></div><div><strong>{agentCount(project, "merge_ready")}</strong><span>マージ可能</span></div><div><strong>{project.lanes.length}</strong><span>Gitレーン</span></div></div></details></div>
      </section>
      <nav className="control-tabs" role="tablist" aria-label="プロジェクト管制画面">
        {tabs.map((tab) => <button aria-selected={urlState.tab === tab.id} className="control-tab" key={tab.id} role="tab" id={`project-tab-${tab.id}`} aria-controls={`project-panel-${tab.id}`} tabIndex={urlState.tab === tab.id ? 0 : -1} type="button" onKeyDown={(event) => {
          const index = tabs.findIndex((item) => item.id === tab.id);
          const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
          if (next === null) return;
          event.preventDefault();
          updateUrl({ tab: tabs[next].id });
          document.getElementById(`project-tab-${tabs[next].id}`)?.focus();
        }} onClick={() => updateUrl({ tab: tab.id })}><span>{tab.label}</span></button>)}
      </nav>
      <div className={`control-layout${selectedEvent || selectedLane ? " has-selection" : ""}`}>
        <section className="control-main" role="tabpanel" id={`project-panel-${urlState.tab}`} aria-labelledby={`project-tab-${urlState.tab}`} tabIndex={0}>
          {urlState.tab === "flow" && <BranchTimeline onOpenGit={openGit} onRangeChange={(range) => updateUrl({ range, at: 100 })} onSelect={selectEvent} onSelectLane={selectLane} onShowMergedChange={setShowMerged} onTimelineChange={(value) => updateUrl({ at: value }, "replace")} project={project} range={urlState.range} selectedKey={selectedHash} selectedLane={selectedLane} selectedRowId={urlState.branchRow} showMerged={urlState.merged} timeline={urlState.at} />}
          {urlState.tab === "lanes" && <WorkLanes searchQuery={laneQuery} onSearch={setLaneQuery} filter={laneFilter} onFilter={setLaneFilter} order={laneOrder} onOrder={setLaneOrder} onOpenGit={openGit} onSelectLane={selectLane} onShowMergedChange={setShowMerged} project={project} selectedLane={selectedLane} showMerged={urlState.merged} />}
          {urlState.tab === "activity" && <><div className="activity-toolbar-spacer" /> <ActivityView searchQuery={activityQuery} onSearch={setActivityQuery} order={activityOrder} onOrder={setActivityOrder} filter={activityFilter} onFilter={(filter) => updateUrl({ activityFilter: filter === "all" ? null : filter, event: null })} onSelect={selectEvent} project={project} /></>}
          {urlState.tab === "info" && <ProjectInfo project={project} />}
        </section>
        {(selectedEvent || selectedLane) && <SelectionPane onClose={closeSelection} onOpenGit={openGit} project={project} selectedEvent={selectedEvent} selectedHash={selectedHash} selectedLane={selectedLane} />}
      </div>
      <GitGuide key={project.main_path} path={project.main_path} />
      {gitPath && legacyRepo && <LegacyGitModal copied={copied} copyError={copyError} onClose={closeGit} onCopy={copy} onTabChange={setGitTab} repo={legacyRepo} tab={gitTab} />}
      {gitPath && !legacyRepo && <LegacyUnavailableModal onClose={closeGit} />}
    </main>
  );
}

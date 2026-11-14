"use client";

import CopyButton from "./copy-button";
import { usePathname, useSearchParams } from "next/navigation";
import { ACKNOWLEDGEMENTS_STORAGE_KEY, agentWorktreeCommand, isAcknowledged, parseAcknowledgements, reportIdentity, updateAcknowledgements } from "./agent-acknowledgements.mjs";
import type { Acknowledgements } from "./agent-acknowledgements.mjs";
import DesktopNotifications from "./desktop-notifications";
import Link from "next/link";
import { useRepoStream } from "./repo-stream";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  agentReportKey,
  agentStateLabel,
  agentStatePriority,
  agentTaskState,
  isExplicitAgentStatus,
} from "./agent-overview.mjs";
import {
  AGENT_DECISION_STATUSES,
  classifyCurrentAgentRows,
  agentReportFreshness,
  currentAgentTasks,
  hasUnknownCurrentTasks,
} from "./agent-timeline-tools.mjs";
import {
  TIMELINE_KIND_ALL,
  TIMELINE_KIND_LIFECYCLE,
  TIMELINE_KIND_STATUS,
  TIMELINE_SORT_NEWEST,
  TIMELINE_SORT_OLDEST,
  TIMELINE_STATUS_ALL,
  TIMELINE_STATUS_UNKNOWN,
  TIMELINE_STATUS_VALUES,
  filterTimelineCurrentRows,
  timelineHistoryCsv,
  timelineHistoryDetails,
} from "./agent-timeline-investigation-tools.mjs";
import type { TimelineFilterOptions } from "./agent-timeline-investigation-tools.mjs";
import type { AgentEvent, AgentTask, ProjectResponse, ProjectSummary } from "./types";
import "./agent-timeline.css";

type TimelineProject = ProjectSummary | ProjectResponse;
type CurrentRow = { project: TimelineProject; task: AgentTask };
type TimelineSnapshot = {
  events: AgentEvent[];
  projects: ProjectSummary[];
  loading: boolean;
  error: string | null;
};

type AgentTimelineProps = {
  agentEvents: AgentEvent[];
  projectSummaries: ProjectSummary[];
  connected: boolean;
  loading?: boolean;
  error?: string | null;
};

const lifecycleLabels: Record<string, string> = {
  session_start: "セッション開始",
  subagent_start: "サブエージェント開始",
  interrupt: "中断",
  subagent_stop: "サブエージェント停止",
  session_end: "セッション終了",
};

const statusLabels: Record<string, string> = {
  investigating: "調査中",
  implementing: "実装中",
  testing: "テスト中",
  reviewing: "レビュー中",
  waiting_for_user: "入力待ち",
  blocked: "問題あり",
  review_required: "レビュー待ち",
  merge_ready: "マージ可能",
  completed: "完了",
  stopped: "中断",
};

function exactTime(value: string | null | undefined) {
  if (!value) return "時刻未取得";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "時刻未取得" : date.toLocaleString("ja-JP");
}

function relativeTime(value: string | null | undefined) {
  if (!value) return "時刻未取得";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "時刻未取得";
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "たった今";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}時間前`;
  return `${Math.floor(seconds / 86_400)}日前`;
}

function statusClass(status: string | null | undefined) {
  return (status || "unknown").replace(/[^a-zA-Z0-9_-]/g, "-");
}

function projectPath(project: TimelineProject | null | undefined) {
  return project && typeof project.main_path === "string" && project.main_path.length > 0
    ? project.main_path
    : null;
}

function projectHref(project: TimelineProject | null | undefined, branch: string | null | undefined) {
  const path = projectPath(project);
  if (!path) return null;
  const params = new URLSearchParams({ path, tab: "flow", range: "7d" });
  if (branch) params.set("lane", `branch:${branch}`);
  return `/project?${params.toString()}`;
}

function projectLabel(project: TimelineProject | null | undefined, projectId: string | null | undefined) {
  if (project?.name) return project.name;
  if (projectId) return projectId.split("/").filter(Boolean).at(-1) || "プロジェクト未取得";
  return "プロジェクト未取得";
}

function branchLabel(branch: string | null | undefined) {
  return branch || "ブランチ未取得";
}

function TimeValue({ value }: { value: string | null | undefined }) {
  return <time className="agent-timeline-time" dateTime={value ?? undefined} title={exactTime(value)}>{relativeTime(value)} · {exactTime(value)}</time>;
}

function ProjectBranch({ project, projectId, branch, children }: {
  project: TimelineProject | null;
  projectId: string | null | undefined;
  branch: string | null | undefined;
  children: ReactNode;
}) {
  const href = projectHref(project, branch);
  const label = `${projectLabel(project, projectId)} / ${branchLabel(branch)}`;
  return href
    ? <Link className="agent-timeline-project-link" href={href} prefetch={false} aria-label={`${label}を開く`}>{children}</Link>
    : <span tabIndex={0} className="agent-timeline-project-link is-unavailable" title="プロジェクトの作業パス未取得">{children}</span>;
}

function currentStatus(task: AgentTask) {
  return agentStateLabel(agentTaskState(task));
}

function CurrentRow({ project, task, oldDecision = false, acknowledged, onAcknowledge, now }: {
  project: TimelineProject; task: AgentTask; oldDecision?: boolean;
  now: number; acknowledged: boolean; onAcknowledge: (task: AgentTask, acknowledged: boolean) => void;
}) {
  const projectId = typeof task.project_id === "string" ? task.project_id : project.id;
  const decision = AGENT_DECISION_STATUSES.includes(agentTaskState(task));
  const command = agentWorktreeCommand(task.worktree);
  const freshness = agentReportFreshness(task.occurred_at, now);
  const reportKey = agentReportKey(task);
  const canAcknowledge = reportKey !== null && reportIdentity(task) !== null;
  return (
    <li className={`agent-timeline-current-row status-${statusClass(agentTaskState(task))}${decision ? ` report-age-${freshness}` : ""}`}>
      <ProjectBranch project={project} projectId={projectId} branch={task.branch}>
        <span className="agent-timeline-row-head"><strong>{projectLabel(project, projectId)}</strong><span>{branchLabel(task.branch)}</span></span>
        <span className="agent-timeline-status-line"><span className="agent-timeline-status">{currentStatus(task)}</span>{task.attention && <span className="agent-timeline-attention">注意: {agentStateLabel(task.attention)}</span>}</span>
        {decision && <span className={`agent-timeline-age age-${freshness}`}>{freshness === "old" ? "古い · 24時間以上" : freshness === "recent" ? "直近 · 24時間未満" : "報告時刻未取得"}</span>}
        <span className="agent-timeline-summary">{task.summary || "報告内容なし"}</span>
        {oldDecision && <span className="agent-timeline-freshness">{relativeTime(task.occurred_at)}から（古い報告）</span>}
        <TimeValue value={task.occurred_at} />
      </ProjectBranch>
      {decision && <div className="agent-timeline-card-actions">
        {canAcknowledge && <button id={reportKey === null ? undefined : `agent-ack-${encodeURIComponent(reportKey)}`} type="button" className="agent-timeline-pause" onClick={() => onAcknowledge(task, !acknowledged)}>{acknowledged ? "未確認に戻す" : "確認済みにする"}</button>}
        {command !== null && <CopyButton value={command} label="worktreeへ移動するコマンドをコピー" />}
      </div>}
    </li>
  );
}

function historicalStatus(event: AgentEvent) {
  if (isExplicitAgentStatus(event)) return agentStateLabel(event.status);
  if (event.kind === "lifecycle") return "ライフサイクル";
  return "状態未取得";
}

function historicalSummary(event: AgentEvent) {
  if (isExplicitAgentStatus(event)) return event.summary || "報告内容なし";
  if (event.kind === "lifecycle") {
    const action = event.action ? lifecycleLabels[event.action] || event.action : "イベント";
    return `${action}（明示状態は更新されません）`;
  }
  return "明示状態の報告内容なし";
}

function HistoryRow({ event, project }: { event: AgentEvent; project: TimelineProject | null }) {
  const projectId = event.project_id;
  return (
    <li className={`agent-timeline-history-row ${event.kind === "lifecycle" ? "is-lifecycle" : "is-status"} status-${statusClass(event.status)}`}>
      <ProjectBranch project={project} projectId={projectId} branch={event.branch}>
        <span className="agent-timeline-row-head"><strong>{projectLabel(project, projectId)}</strong><span>{branchLabel(event.branch)}</span></span>
        <span className="agent-timeline-status-line"><span className="agent-timeline-status">{historicalStatus(event)}</span></span>
        <span className="agent-timeline-summary">{historicalSummary(event)}</span>
        <TimeValue value={event.occurred_at} />
      </ProjectBranch>
    </li>
  );
}

function sortCurrentRows(rows: CurrentRow[]) {
  return [...rows].sort((left, right) => {
    const leftPriority = agentStatePriority(agentTaskState(left.task) as string | null) ?? Number.MAX_SAFE_INTEGER;
    const rightPriority = agentStatePriority(agentTaskState(right.task) as string | null) ?? Number.MAX_SAFE_INTEGER;
    const byState = leftPriority - rightPriority;
    if (byState) return byState;
    const leftTime = left.task.occurred_at ? Date.parse(left.task.occurred_at) : 0;
    const rightTime = right.task.occurred_at ? Date.parse(right.task.occurred_at) : 0;
    return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0)
      || projectLabel(left.project, left.project.id).localeCompare(projectLabel(right.project, right.project.id))
      || branchLabel(left.task.branch).localeCompare(branchLabel(right.task.branch));
  });
}

function downloadTimelineCsv(events: AgentEvent[], setStatus: (value: string) => void) {
  try {
    const blob = new Blob([timelineHistoryCsv(events)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "gitdash-agent-timeline.csv";
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus(`${events.length}件のCSV保存を開始しました。`);
  } catch {
    setStatus("CSVを保存できませんでした。");
  }
}

export default function AgentTimelineSidebar({
  agentEvents,
  projectSummaries,
  connected,
  loading = false,
  error = null,
}: AgentTimelineProps) {
  const { loadOlderEvents, historyHasMore, historyLoading, historyError } = useRepoStream();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const [isPaused, setIsPaused] = useState(false);
  const [frozenSnapshot, setFrozenSnapshot] = useState<TimelineSnapshot>({
    events: agentEvents,
    projects: projectSummaries,
    loading,
    error,
  });
  const [acknowledgements, setAcknowledgements] = useState<Acknowledgements>({});
  const [acknowledgementsIssue, setAcknowledgementsIssue] = useState(false);
  const [onlyCurrentProject, setOnlyCurrentProject] = useState(false);
  const [scopeStorageIssue, setScopeStorageIssue] = useState(false);
  const pathname = usePathname();
  const routePath = useSearchParams().get("path");
  const isProjectPage = pathname === "/project";
  const scoped = isProjectPage && onlyCurrentProject;
  const routeProject = isProjectPage && routePath !== null
    ? projectSummaries.find((project) => project.main_path === routePath) : undefined;
  const scopedProjectId = routeProject === undefined ? null : routeProject.id;
  useEffect(() => {
    const readAcknowledgements = () => {
      try {
        const parsed = parseAcknowledgements(localStorage.getItem(ACKNOWLEDGEMENTS_STORAGE_KEY));
        if (parsed === null) { setAcknowledgementsIssue(true); return; }
        setAcknowledgements(parsed);
        setAcknowledgementsIssue(false);
      } catch { setAcknowledgementsIssue(true); }
    };
    readAcknowledgements();
    try { setOnlyCurrentProject(localStorage.getItem("gitdash.agent-timeline-current-project") === "true"); }
    catch { setScopeStorageIssue(true); }
    const sync = (event: StorageEvent) => {
      if (event.key === ACKNOWLEDGEMENTS_STORAGE_KEY || event.key === null) readAcknowledgements();
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  const saveAcknowledgements = (tasks: AgentTask[], acknowledged: boolean, focusId: string) => {
    const next = updateAcknowledgements(tasks, acknowledgements, acknowledged);
    setAcknowledgements(next);
    try { localStorage.setItem(ACKNOWLEDGEMENTS_STORAGE_KEY, JSON.stringify(next)); setAcknowledgementsIssue(false); }
    catch { setAcknowledgementsIssue(true); }
    window.requestAnimationFrame(() => { document.getElementById(focusId)?.focus(); });
  };
  const acknowledge = (task: AgentTask, acknowledged: boolean) => {
    const key = agentReportKey(task);
    if (key === null || reportIdentity(task) === null) return;
    saveAcknowledgements([task], acknowledged, acknowledged ? "agent-acknowledged-summary" : `agent-ack-${encodeURIComponent(key)}`);
  };
  const bulkAcknowledge = (rows: CurrentRow[], acknowledged: boolean) => {
    const tasks = rows.map(({ task }) => task).filter((task) => agentReportKey(task) !== null && reportIdentity(task) !== null);
    if (tasks.length === 0) return;
    const description = acknowledged ? "古い判断待ちを確認済み" : "確認済みの報告を未確認";
    if (!window.confirm(`現在の絞り込みに一致する${tasks.length}件の${description}にします。報告の状態は変更しません。よろしいですか？`)) return;
    saveAcknowledgements(tasks, acknowledged, acknowledged ? "agent-acknowledged-summary" : "agent-timeline-current-title");
  };
  const toggleProjectScope = () => {
    const next = !onlyCurrentProject;
    setOnlyCurrentProject(next);
    try { localStorage.setItem("gitdash.agent-timeline-current-project", String(next)); setScopeStorageIssue(false); }
    catch { setScopeStorageIssue(true); }
  };
  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>(TIMELINE_STATUS_ALL);
  const [kindFilter, setKindFilter] = useState<"all" | "status" | "lifecycle">(TIMELINE_KIND_ALL);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [historySort, setHistorySort] = useState<"newest" | "oldest">(TIMELINE_SORT_NEWEST);
  const [exportStatus, setExportStatus] = useState("");

  const displaySnapshot = isPaused
    ? frozenSnapshot
    : { events: agentEvents, projects: projectSummaries, loading, error };
  const projects = displaySnapshot.projects;
  const events = displaySnapshot.events;
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);

  const currentRows = useMemo(
    () => sortCurrentRows(currentAgentTasks(projects) as CurrentRow[]),
    [projects],
  );
  const unknownCurrent = useMemo(() => hasUnknownCurrentTasks(projects), [projects]);

  const filterOptions = useMemo<TimelineFilterOptions>(() => ({
    query,
    projectId: scoped ? scopedProjectId : projectFilter,
    status: statusFilter,
    kind: kindFilter,
    startDate,
    endDate,
    sort: historySort,
  }), [query, projectFilter, scoped, scopedProjectId, statusFilter, kindFilter, startDate, endDate, historySort]);

  const filteredCurrentRows = useMemo(
    () => scoped && scopedProjectId === null ? [] : filterTimelineCurrentRows(currentRows, filterOptions),
    [currentRows, filterOptions, scoped, scopedProjectId],
  );
  const acknowledgedRows = useMemo(() => filteredCurrentRows.filter(({ task }) =>
    AGENT_DECISION_STATUSES.includes(agentTaskState(task)) && isAcknowledged(task, acknowledgements)), [filteredCurrentRows, acknowledgements]);
  const currentGroups = useMemo(
    () => classifyCurrentAgentRows(filteredCurrentRows.filter(({ task }) => !AGENT_DECISION_STATUSES.includes(agentTaskState(task)) || !isAcknowledged(task, acknowledgements)), now),
    [filteredCurrentRows, acknowledgements, now],
  );
  const renderCurrentRows = (rows: CurrentRow[], oldDecision = false) => (
    <ul className="agent-timeline-list agent-timeline-current-list">{rows.map(({ project, task }) => <CurrentRow key={agentReportKey(task)} project={project} task={task} oldDecision={oldDecision} acknowledged={isAcknowledged(task, acknowledgements)} onAcknowledge={acknowledge} now={now} />)}</ul>
  );
  const decisionCount = AGENT_DECISION_STATUSES.reduce((sum, status) => sum + currentGroups.decisionCounts[status], 0);
  const historyDetails = useMemo(
    () => timelineHistoryDetails(events, filterOptions, projectById),
    [events, filterOptions, projectById],
  );
  const history = scoped && scopedProjectId === null ? [] : historyDetails.filtered;
  const currentLoading = displaySnapshot.loading && projects.length === 0;

  const projectOptions = useMemo(() => {
    const labels = new Map<string, string>();
    for (const project of projects) labels.set(project.id, project.name || project.id);
    if (routeProject !== undefined) labels.set(routeProject.id, routeProject.name);
    for (const event of events) {
      if (typeof event.project_id === "string" && event.project_id.length > 0 && !labels.has(event.project_id)) {
        labels.set(event.project_id, projectLabel(null, event.project_id));
      }
    }
    return [...labels.entries()].sort((left, right) => left[1].localeCompare(right[1]) || left[0].localeCompare(right[0]));
  }, [events, projects, routeProject]);

  const hasFilters = Boolean(scoped || query.trim() || projectFilter || statusFilter !== TIMELINE_STATUS_ALL || kindFilter !== TIMELINE_KIND_ALL || startDate || endDate || historySort !== TIMELINE_SORT_NEWEST);
  const filteredSummary = `取得済み ${events.length}件の履歴を対象 · 現在 ${filteredCurrentRows.length}件 / 履歴 ${history.length}件を表示`;

  const togglePause = () => {
    if (isPaused) {
      setIsPaused(false);
      return;
    }
    setFrozenSnapshot({ events: agentEvents, projects: projectSummaries, loading, error });
    setIsPaused(true);
  };

  const clearFilters = () => {
    if (scoped) toggleProjectScope();
    setQuery("");
    setProjectFilter("");
    setStatusFilter(TIMELINE_STATUS_ALL);
    setKindFilter(TIMELINE_KIND_ALL);
    setStartDate("");
    setEndDate("");
    setHistorySort(TIMELINE_SORT_NEWEST);
  };

  return (
    <aside className="agent-timeline-sidebar" aria-label="agentタイムライン">
      <div className="agent-timeline-heading">
        <div><p className="eyebrow">AGENT ACTIVITY</p><h2>agentタイムライン</h2></div>
        <div className="agent-timeline-heading-actions">
          <span className={`agent-timeline-connection${connected ? " is-on" : ""}`} aria-label={connected ? "ライブ接続中" : "再接続中"}><i aria-hidden="true" />{connected ? "ライブ" : "再接続"}</span>
          <button type="button" className={`agent-timeline-pause${isPaused ? " is-paused" : ""}`} onClick={togglePause} aria-pressed={isPaused} aria-label={isPaused ? "ライブ更新へ戻す" : "表示中のタイムラインを固定する"}>
            {isPaused ? "ライブに戻す" : "表示を固定"}
          </button>
        </div>
      </div>
      <DesktopNotifications />
      {isProjectPage && <div className="agent-timeline-scope"><button type="button" className="agent-timeline-pause" aria-pressed={onlyCurrentProject} onClick={toggleProjectScope}>このプロジェクトのみ</button>{scoped && <span>{routeProject === undefined ? "現在のプロジェクト情報は未取得です" : routeProject.name}</span>}</div>}
      {scopeStorageIssue && <p role="status" className="agent-timeline-caption">プロジェクト絞り込みの設定を保存・復元できません。この画面でのみ適用します。</p>}
      {acknowledgementsIssue && <p role="status" className="agent-timeline-caption">確認済みの設定を保存・復元できません。この画面でのみ適用します。</p>}
      {isPaused && <p className="agent-timeline-paused" role="status" aria-live="polite"><span aria-hidden="true">Ⅱ</span> 表示を固定中。新しい報告は表示していません。</p>}
      {displaySnapshot.error && <p className="agent-timeline-empty agent-timeline-error" role="alert">報告を再取得できませんでした。表示中の情報は最新ではない可能性があります。</p>}

      <div className="agent-timeline-scroll">
        <details className="agent-timeline-filters" open={hasFilters}>
          <summary>絞り込み・表示 <span>{hasFilters ? "条件あり" : "条件なし"}</span></summary>
          <div className="agent-timeline-filter-grid">
            <label className="agent-timeline-filter-search"><span>検索</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="プロジェクト・ブランチ・要約" aria-label="プロジェクト、ブランチ、要約、worktreeを検索" /></label>
            <label><span>プロジェクト</span><select disabled={scoped} value={scoped ? (scopedProjectId === null ? "" : scopedProjectId) : projectFilter} onChange={(event) => setProjectFilter(event.target.value)} aria-label="プロジェクトを完全一致で絞り込み"><option value="">{scoped ? "現在のプロジェクト情報は未取得です" : "すべてのプロジェクト"}</option>{projectOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
            <label><span>明示状態</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="明示されたagent状態で絞り込み"><option value={TIMELINE_STATUS_ALL}>すべての状態</option>{TIMELINE_STATUS_VALUES.map((status) => <option key={status} value={status}>{statusLabels[status] || status}</option>)}<option value={TIMELINE_STATUS_UNKNOWN}>明示状態なし</option></select></label>
            <label><span>履歴種別</span><select value={kindFilter} onChange={(event) => setKindFilter(event.target.value as "all" | "status" | "lifecycle")} aria-label="履歴イベント種別で絞り込み"><option value={TIMELINE_KIND_ALL}>すべて</option><option value={TIMELINE_KIND_STATUS}>状態報告</option><option value={TIMELINE_KIND_LIFECYCLE}>ライフサイクル</option></select></label>
            <label><span>開始日</span><input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} aria-label="履歴の開始日" /></label>
            <label><span>終了日</span><input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} aria-label="履歴の終了日" /></label>
            <label><span>履歴の順序</span><select value={historySort} onChange={(event) => setHistorySort(event.target.value as "newest" | "oldest")} aria-label="履歴の並び順"><option value={TIMELINE_SORT_NEWEST}>新しい順</option><option value={TIMELINE_SORT_OLDEST}>古い順</option></select></label>
            <button type="button" className="agent-timeline-clear" onClick={clearFilters} disabled={!hasFilters}>条件を解除</button>
          </div>
          {scoped && <p className="agent-timeline-caption">プロジェクト選択は「このプロジェクトのみ」に連動しています。手動で選ぶ場合は上のボタンを解除してください。</p>}
          <p className="agent-timeline-coverage" role="status">{filteredSummary}。条件はこの画面で取得済みのスナップショットだけに適用します。</p>
        </details>

        <section className="agent-timeline-current" aria-labelledby="agent-timeline-current-title">
          <div className="agent-timeline-section-heading"><h3 id="agent-timeline-current-title" tabIndex={-1}>現在の注意・状態</h3><span>{filteredCurrentRows.length}件</span></div>
          <p className="agent-timeline-caption">最新の明示状態を表示。直近は24時間未満です。確認済みはこのブラウザでの閲覧記録で、報告の状態は変えません。タイトル・ホーム集計・上部の件数は確認済みを含みます。</p>
          {currentLoading && <p className="agent-timeline-empty" role="status">現在の状態を取得中…</p>}
          {!currentLoading && filteredCurrentRows.length === 0 && unknownCurrent && <p className="agent-timeline-empty" role="status">現在の状態を取得できないプロジェクトがあります。</p>}
          {!currentLoading && filteredCurrentRows.length === 0 && !unknownCurrent && projects.length > 0 && <p className="agent-timeline-empty" role="status">条件に一致する明示された現在の状態はありません。</p>}
          {!currentLoading && filteredCurrentRows.length === 0 && !unknownCurrent && projects.length === 0 && !displaySnapshot.error && <p className="agent-timeline-empty" role="status">明示された現在の状態はありません。</p>}
          {filteredCurrentRows.length > 0 && <>
            <div className="agent-timeline-current-group">
              <h4>未確認の判断待ち · {decisionCount}件<span className="agent-timeline-decision-counts">{AGENT_DECISION_STATUSES.map((status) => `${statusLabels[status]} ${currentGroups.decisionCounts[status]}件`).join(" · ")}</span></h4>
              {currentGroups.decision.recent.length > 0 && <><h5>直近 · {currentGroups.decision.recent.length}件</h5>{renderCurrentRows(currentGroups.decision.recent)}</>}
              {currentGroups.decision.old.length > 0 && <details className="agent-timeline-old-reports"><summary>古い判断待ち · {currentGroups.decision.old.length}件</summary><div className="agent-timeline-bulk-actions"><button type="button" className="agent-timeline-pause" onClick={() => bulkAcknowledge(currentGroups.decision.old, true)}>このグループを一括で確認済みにする</button><span>現在の絞り込みに一致する古い判断待ちが対象です。</span></div>{renderCurrentRows(currentGroups.decision.old, true)}</details>}
              {currentGroups.decision.unknown.length > 0 && <><h5>報告時刻未取得 · {currentGroups.decision.unknown.length}件</h5>{renderCurrentRows(currentGroups.decision.unknown)}</>}
            </div>
            {acknowledgedRows.length > 0 && <details className="agent-timeline-acknowledged"><summary id="agent-acknowledged-summary">確認済み · {acknowledgedRows.length}件</summary><div className="agent-timeline-bulk-actions"><button type="button" className="agent-timeline-pause" onClick={() => bulkAcknowledge(acknowledgedRows, false)}>このグループを一括で未確認に戻す</button><span>現在の絞り込みに一致する確認済みの報告が対象です。</span></div>{renderCurrentRows(acknowledgedRows)}</details>}
            <div className="agent-timeline-current-group"><h4>実行中として報告 · {currentGroups.active.length}件</h4>{renderCurrentRows(currentGroups.active)}</div>
            {currentGroups.finished.length > 0 && <div className="agent-timeline-current-group"><h4>直近の完了・中断 · {currentGroups.finished.length}件</h4>{renderCurrentRows(currentGroups.finished)}</div>}
            {currentGroups.old.length > 0 && <details className="agent-timeline-old-reports"><summary>古い報告 · {currentGroups.old.length}件</summary>{renderCurrentRows(currentGroups.old)}</details>}
            {currentGroups.unknown.length > 0 && <div className="agent-timeline-current-group"><h4>報告時刻未取得 · {currentGroups.unknown.length}件</h4>{renderCurrentRows(currentGroups.unknown)}</div>}
          </>}
          {filteredCurrentRows.length > 0 && unknownCurrent && <p className="agent-timeline-unknown-note" role="status">一部のプロジェクトは現在状態未取得です。</p>}
        </section>

        <section className="agent-timeline-history" aria-labelledby="agent-timeline-history-title">
          <div className="agent-timeline-section-heading"><h3 id="agent-timeline-history-title">履歴</h3><span>{history.length} / {events.length}件</span></div>
          <p className="agent-timeline-caption">取得済みイベントだけを表示します。ライフサイクルは状態報告と区別しています。</p>
          {historyDetails.dateWindow.error && <p className="agent-timeline-empty agent-timeline-error" role="alert">{historyDetails.dateWindow.error}</p>}
          {history.length === 0 && displaySnapshot.loading && events.length === 0 && <p className="agent-timeline-empty" role="status">履歴を取得中…</p>}
          {history.length === 0 && !displaySnapshot.loading && displaySnapshot.error && <p className="agent-timeline-empty agent-timeline-error" role="alert">履歴を取得できませんでした。</p>}
          {history.length === 0 && !displaySnapshot.loading && !displaySnapshot.error && !historyDetails.dateWindow.error && events.length === 0 && <p className="agent-timeline-empty" role="status">保存されたagentイベントはありません。</p>}
          {history.length === 0 && !displaySnapshot.loading && !displaySnapshot.error && !historyDetails.dateWindow.error && events.length > 0 && <p className="agent-timeline-empty" role="status">条件に一致する取得済み履歴はありません。</p>}
          {history.length > 0 && <ol className="agent-timeline-list agent-timeline-history-list">{history.map((event) => <HistoryRow key={event.event_id} event={event} project={event.project_id ? projectById.get(event.project_id) || null : null} />)}</ol>}
          {historyError && <p className="agent-timeline-empty agent-timeline-error" role="alert">古い履歴を取得できませんでした。{historyError}</p>}
          {historyHasMore && <button type="button" disabled={historyLoading || isPaused} onClick={loadOlderEvents}>{historyLoading ? "履歴を取得中…" : "さらに読み込む"}</button>}
          <div className="agent-timeline-history-actions">
            <button type="button" className="agent-timeline-export" disabled={history.length === 0} onClick={() => downloadTimelineCsv(history, setExportStatus)} aria-label="絞り込み済み履歴をCSV保存">絞り込み済み履歴をCSV保存</button>
            <span className="agent-timeline-export-status" role={exportStatus === "CSVを保存できませんでした。" ? "alert" : "status"} aria-live="polite">{exportStatus}</span>
          </div>
        </section>
      </div>
    </aside>
  );
}

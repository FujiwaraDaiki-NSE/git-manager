"use client";

import Link from "next/link";
import { useMemo } from "react";
import {
  agentReportKey,
  agentStateLabel,
  agentStatePriority,
  agentTaskState,
  isExplicitAgentStatus,
} from "./agent-overview.mjs";
import {
  currentAgentTasks,
  hasUnknownCurrentTasks,
  sortTimelineEvents,
} from "./agent-timeline-tools.mjs";
import type { AgentEvent, AgentTask, ProjectResponse, ProjectSummary } from "./types";
import "./agent-timeline.css";

type TimelineProject = ProjectSummary | ProjectResponse;

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
  const params = new URLSearchParams({ path, tab: "flow", range: "current" });
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
  children: React.ReactNode;
}) {
  const href = projectHref(project, branch);
  const label = `${projectLabel(project, projectId)} / ${branchLabel(branch)}`;
  return href
    ? <Link className="agent-timeline-project-link" href={href} prefetch={false} aria-label={`${label}を開く`}>{children}</Link>
    : <span className="agent-timeline-project-link is-unavailable" title="プロジェクトの作業パス未取得">{children}</span>;
}

function currentStatus(task: AgentTask) {
  return agentStateLabel(agentTaskState(task));
}

function CurrentRow({ project, task }: { project: TimelineProject; task: AgentTask }) {
  const projectId = typeof task.project_id === "string" ? task.project_id : project.id;
  return (
    <li className={`agent-timeline-current-row status-${statusClass(agentTaskState(task))}`}>
      <ProjectBranch project={project} projectId={projectId} branch={task.branch}>
        <span className="agent-timeline-row-head"><strong>{projectLabel(project, projectId)}</strong><span>{branchLabel(task.branch)}</span></span>
        <span className="agent-timeline-status-line"><span className="agent-timeline-status">{currentStatus(task)}</span>{task.attention && <span className="agent-timeline-attention">注意: {agentStateLabel(task.attention)}</span>}</span>
        <span className="agent-timeline-summary">{task.summary || "報告内容なし"}</span>
        <TimeValue value={task.occurred_at} />
      </ProjectBranch>
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

function sortCurrentRows(rows: Array<{ project: TimelineProject; task: AgentTask }>) {
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

export default function AgentTimelineSidebar({
  agentEvents,
  projectSummaries,
  connected,
  loading = false,
  error = null,
}: AgentTimelineProps) {
  const projects = projectSummaries;
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const currentRows = useMemo(
    () => sortCurrentRows((currentAgentTasks(projectSummaries) as Array<{ project: TimelineProject; task: AgentTask }>)
      .filter(({ task }) => {
        const status = agentTaskState(task);
        return status !== "completed" && status !== "stopped";
      })),
    [projectSummaries],
  );
  const history = useMemo(() => sortTimelineEvents(agentEvents), [agentEvents]);
  const unknownCurrent = useMemo(() => hasUnknownCurrentTasks(projectSummaries), [projectSummaries]);
  const currentLoading = loading && projects.length === 0;

  return (
    <aside className="agent-timeline-sidebar" aria-label="agentタイムライン">
      <div className="agent-timeline-heading">
        <div><p className="eyebrow">AGENT ACTIVITY</p><h2>agentタイムライン</h2></div>
        <span className={`agent-timeline-connection${connected ? " is-on" : ""}`} aria-label={connected ? "ライブ更新中" : "再接続中"}><i aria-hidden="true" />{connected ? "ライブ" : "再接続"}</span>
      </div>
      {error && <p className="agent-timeline-empty agent-timeline-error" role="alert">報告を再取得できませんでした。表示中の情報は最新ではない可能性があります。</p>}
      <div className="agent-timeline-scroll">
        <section className="agent-timeline-current" aria-labelledby="agent-timeline-current-title">
          <div className="agent-timeline-section-heading"><h3 id="agent-timeline-current-title">現在の注意・状態</h3><span>{currentRows.length}件</span></div>
          <p className="agent-timeline-caption">最後に届いた報告です。完了・中断は履歴で確認できます。</p>
          {currentLoading && <p className="agent-timeline-empty" role="status">現在の状態を取得中…</p>}
          {!currentLoading && currentRows.length === 0 && unknownCurrent && <p className="agent-timeline-empty" role="status">現在の状態を取得できないプロジェクトがあります。</p>}
          {!currentLoading && currentRows.length === 0 && !unknownCurrent && <p className="agent-timeline-empty" role="status">明示された現在の状態はありません。</p>}
          {currentRows.length > 0 && <ul className="agent-timeline-list agent-timeline-current-list">{currentRows.map(({ project, task }) => <CurrentRow key={agentReportKey(task) || `${project.id}:${task.branch || "unknown"}`} project={project} task={task} />)}</ul>}
          {currentRows.length > 0 && unknownCurrent && <p className="agent-timeline-unknown-note" role="status">一部のプロジェクトは現在状態未取得です。</p>}
        </section>

        <section className="agent-timeline-history" aria-labelledby="agent-timeline-history-title">
          <div className="agent-timeline-section-heading"><h3 id="agent-timeline-history-title">履歴</h3><span>{history.length}件</span></div>
          <p className="agent-timeline-caption">保存済みイベントを新しい順に表示します。ライフサイクルは状態報告と区別しています。</p>
          {history.length === 0 && loading && <p className="agent-timeline-empty" role="status">履歴を取得中…</p>}
          {history.length === 0 && !loading && error && <p className="agent-timeline-empty agent-timeline-error" role="alert">履歴を取得できませんでした。</p>}
          {history.length === 0 && !loading && !error && <p className="agent-timeline-empty" role="status">保存されたagentイベントはありません。</p>}
          {history.length > 0 && <ol className="agent-timeline-list agent-timeline-history-list">{history.map((event) => <HistoryRow key={event.event_id} event={event} project={event.project_id ? projectById.get(event.project_id) || null : null} />)}</ol>}
        </section>
      </div>
    </aside>
  );
}

"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { agentStateLabel, deferProjectOrder, projectLatestTime, sortProjects, topAgentTasks } from "./agent-overview.mjs";
import { useRepoStream } from "./repo-stream";
import type { AgentRunState, ProjectSummary } from "./types";

const summaryCards = [
  { key: "waiting_for_user", label: "入力待ち" },
  { key: "blocked", label: "問題あり" },
  { key: "active", label: "実行中" },
  { key: "review_required", label: "レビュー待ち" },
  { key: "merge_ready", label: "統合可能" },
] as const;

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

function ProjectCard({ project, onInteractEnd, onInteractStart }: { project: ProjectSummary; onInteractEnd: () => void; onInteractStart: () => void }) {
  const target = project.main_path || project.id;
  const href = `/project?path=${encodeURIComponent(target)}&tab=flow&range=current`;
  const state = project.priority_state;
  const tasks = topAgentTasks(project.agent_tasks, 3);
  const latestAgent = project.latest_agent_event;
  const latestGit = project.latest_event;
  const maxRemainder = Math.max(0, (project.agent_tasks?.length ?? 0) - tasks.length);
  const hasAttention = project.git.conflict > 0 || project.git.dirty > 0 || project.git.behind > 0 || project.git.ahead > 0 || state === "blocked";
  return (
    <article className={`project-card${hasAttention ? " project-card-attention" : ""}`} onFocusCapture={onInteractStart} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onInteractEnd(); }} onPointerEnter={onInteractStart} onPointerLeave={onInteractEnd}>
      <div className="project-card-topline"><span className={`agent-state-badge ${stateClass(state)}`}>{agentStateLabel(state)}</span><span className="project-lane-count">{project.lane_count === null ? "Gitレーン 未取得" : `${project.lane_count} Gitレーン`}</span></div>
      <div className="project-card-heading"><div className="project-card-title-wrap"><h2>{project.name}</h2><code title={remoteLabel(project.remote)}>{remoteLabel(project.remote)}</code></div><Link className="open-project" href={href} aria-label={`${project.name} の管制画面を開く`}>開く <span aria-hidden="true">↗</span></Link></div>
      <div className="project-card-agent-counts" aria-label="agentタスク件数">{summaryCards.map(({ key, label }) => <span key={key}><strong>{project.agent_counts?.[key] ?? "?"}</strong> {label}</span>)}<span><strong>{project.agent_counts?.completed ?? "?"}</strong> 完了</span></div>
      <div className="project-card-agent-list" aria-label="上位 agent タスク">
        {tasks.length ? tasks.map((task) => <div className="agent-task-row" key={task.task_id}><span className={`agent-task-state ${stateClass(task.run_state)}`}>{agentStateLabel(task.run_state)}</span><strong>{task.agent_id || task.task_id}</strong><span>{task.summary || "報告内容なし"}</span></div>) : <div className="agent-task-row agent-task-unknown"><span className="agent-dot" aria-hidden="true" /><strong>agent 状態不明</strong><span>タスク未取得</span></div>}
        {maxRemainder > 0 && <span className="agent-remainder">+{maxRemainder} 件</span>}
      </div>
      <div className="project-card-event"><span className="eyebrow">最終明示レポート</span>{latestAgent ? <><strong title={latestAgent.summary || undefined}>{latestAgent.summary || "報告内容なし"}</strong><time dateTime={latestAgent.occurred_at ?? undefined} title={exactDate(latestAgent.occurred_at)}>{relativeTime(latestAgent.occurred_at)} · {exactDate(latestAgent.occurred_at)}</time></> : latestGit ? <><strong title={latestGit.subject}>{latestGit.subject}</strong><time dateTime={latestGit.date} title={exactDate(latestGit.date)}>Git · {relativeTime(latestGit.date)} · {exactDate(latestGit.date)}</time></> : <strong className="unknown">未取得</strong>}</div>
      <div className="project-card-facts" aria-label="Git補助情報"><span className={project.git.conflict > 0 ? "fact fact-danger" : "fact"}>conflict {project.git.conflict}</span><span className={project.git.dirty > 0 ? "fact fact-warn" : "fact"}>変更 {project.git.dirty}</span><span className="fact">ahead {project.git.ahead}</span><span className="fact">behind {project.git.behind}</span></div>
      <div className="project-card-footer"><span>次に確認: <strong>{project.next_lane ?? "未取得"}</strong></span><span>最大差 {project.largest_difference_lane ?? "未取得"}</span></div>
      <div className="project-card-secondary">worktree {project.worktree_count} · merged {project.git.merged} · 最終観測 {projectLatestTime(project) ? relativeTime(new Date(projectLatestTime(project)).toISOString()) : "未取得"}</div>
    </article>
  );
}

export default function Page() {
  const { repos, scanning, fetching, connected, agentEventVersion } = useRepoStream();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [displayOrder, setDisplayOrder] = useState<string[]>([]);
  const [deferredOrder, setDeferredOrder] = useState<string[] | null>(null);
  const [interactionId, setInteractionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const snapshotKey = useMemo(() => [...repos.values()].map((repo) => `${repo.path}:${repo.checked_at ?? repo.activity ?? 0}`).sort().join("|"), [repos]);
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void fetch("/api/projects", { cache: "no-store" }).then(async (response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return (await response.json()) as { projects: ProjectSummary[] }; }).then((value) => {
        if (cancelled) return;
        setProjects(value.projects);
        setLoading(false); setError(null);
      }).catch((reason: unknown) => { if (!cancelled) { setLoading(false); setError(reason instanceof Error ? reason.message : "unknown error"); } });
    }, snapshotKey ? 120 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [snapshotKey, agentEventVersion]);
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
  const ordered = useMemo(() => { const byId = new Map(projects.map((project) => [project.id, project])); return displayOrder.map((id) => byId.get(id)).filter((project): project is ProjectSummary => Boolean(project)); }, [displayOrder, projects]);
  const visible = useMemo(() => { const value = query.trim().toLowerCase(); return value ? ordered.filter((project) => [project.name, project.id, project.remote, project.main_path].filter(Boolean).some((item) => item!.toLowerCase().includes(value))) : ordered; }, [ordered, query]);
  const totals = useMemo(() => summaryCards.reduce((result, { key }) => ({ ...result, [key]: projects.reduce((sum, project) => sum + (project.agent_counts?.[key] ?? 0), 0) }), { waiting_for_user: 0, blocked: 0, active: 0, review_required: 0, merge_ready: 0 }), [projects]);
  const gitTotals = useMemo(() => ({ conflicts: projects.reduce((sum, item) => sum + item.git.conflict, 0), dirty: projects.reduce((sum, item) => sum + item.git.dirty, 0), lanes: projects.every((item) => item.lane_count !== null) ? projects.reduce((sum, item) => sum + (item.lane_count ?? 0), 0) : null }), [projects]);
  const startInteraction = (id?: string) => setInteractionId(id || "grid");
  const finishInteraction = () => setInteractionId(null);
  const applyOrder = () => { if (deferredOrder) { setDisplayOrder(deferredOrder); setDeferredOrder(null); } };
  return (
    <main className="home-shell"><header className="home-header"><div className="brand-lockup"><span className="brand-mark" aria-hidden="true">gd</span><div><p className="brand-kicker">read-only development observatory</p><h1>gitdash</h1></div></div><div className="connection-state" aria-live="polite"><span className={`connection-dot${connected ? " is-on" : ""}`} aria-hidden="true" />{connected ? "同期中" : "接続待ち"}{scanning && <span> · 走査中</span>}{fetching && <span> · fetch 中</span>}</div></header>
      <section className="home-intro" aria-labelledby="home-title"><div><p className="eyebrow">PROJECT CONTROL BOARD</p><h2 id="home-title">次に判断する作業</h2><p className="intro-copy">agent の明示した状態を最優先に、Git の観測事実を補助情報としてプロジェクトごとに確認します。</p></div><div className="home-summary" aria-label="agentタスクサマリー">{summaryCards.map(({ key, label }) => <div key={key}><strong>{totals[key]}</strong><span>{label}</span></div>)}</div></section>
      <section className="home-toolbar" aria-label="プロジェクト検索"><label className="home-search"><span className="sr-only">プロジェクトを検索</span><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="プロジェクト、パス、リモートを検索" type="search" /></label><span className="toolbar-note">Git変更 {gitTotals.dirty} · conflict {gitTotals.conflicts} · Gitレーン {gitTotals.lanes ?? "?"}</span></section>
      {deferredOrder && <div className="order-update" role="status"><span>並び順に更新があります</span><button type="button" onClick={applyOrder}>並び順を更新</button></div>}
      {loading && <div className="home-state" role="status">プロジェクトを取得中…</div>}{error && <div className="home-state home-state-error" role="alert">プロジェクト情報を取得できませんでした。<span className="sr-only">{error}</span></div>}{!loading && !error && visible.length === 0 && <div className="home-state">該当するプロジェクトがありません。</div>}
      <section className="project-grid" aria-label="プロジェクト一覧">{visible.map((project) => <ProjectCard key={project.id} onInteractEnd={finishInteraction} onInteractStart={() => startInteraction(project.id)} project={project} />)}</section>
      <p className="home-footnote"><span className="legend-line" aria-hidden="true" /> agent の明示状態・最新報告を優先。Git の件数は補助情報です。</p>
    </main>
  );
}

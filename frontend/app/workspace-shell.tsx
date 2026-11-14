"use client";

import { Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { currentAgentTasks } from "./agent-timeline-tools.mjs";
import { agentTaskState } from "./agent-overview.mjs";
import FaviconBadge from "./favicon-badge";
import { aggregateAgentCounts } from "./home-overview.mjs";
import AgentTimelineSidebar from "./agent-timeline";
import { RepoStreamProvider, useRepoStream } from "./repo-stream";

function WorkspaceContent({ children }: { children: ReactNode }) {
  const { agentEvents, projectSummaries, connected, agentDataLoading, agentDataError } = useRepoStream();
  const [collapsed, setCollapsed] = useState(false);
  const [storageIssue, setStorageIssue] = useState(false);
  useEffect(() => {
    try { setCollapsed(localStorage.getItem("gitdash.agent-sidebar-collapsed") === "true"); }
    catch { setStorageIssue(true); }
  }, []);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem("gitdash.agent-sidebar-collapsed", String(next)); }
    catch { setStorageIssue(true); }
  };
  const waitingCount = useMemo(() => aggregateAgentCounts(projectSummaries).waiting_for_user, [projectSummaries]);
  const tasks = currentAgentTasks(projectSummaries);
  const waiting = tasks.filter(({ task }) => agentTaskState(task) === "waiting_for_user").length;
  const blocked = tasks.filter(({ task }) => agentTaskState(task) === "blocked").length;
  const unknown = agentDataLoading || agentDataError !== null || projectSummaries.some((project) => project.agent_tasks === null);
  const attention = `全プロジェクトの報告（確認済みを含む）：入力待ち ${waiting}件 · 問題あり ${blocked}件${unknown ? " · 一部未取得" : ""}`;
  return <div className={`workspace-agent-layout${collapsed ? " is-sidebar-collapsed" : ""}`}>
    <Suspense fallback={null}><FaviconBadge waiting={waitingCount} /></Suspense>
    <div className="agent-sidebar-controls">
      <button type="button" className="agent-timeline-pause" onClick={toggle} aria-expanded={!collapsed} aria-controls="workspace-agent-timeline">{collapsed ? "agentタイムラインを開く" : "agentタイムラインを折りたたむ"}</button>
      <span role="status">{attention}{!connected && " · 再接続中"}</span>
      {storageIssue && <span role="status">開閉状態を保存・復元できません。</span>}
    </div>
    <div className="workspace-primary">{children}</div>
    <div id="workspace-agent-timeline" className="workspace-agent-sidebar" hidden={collapsed}><Suspense fallback={<p role="status">タイムラインを読み込み中…</p>}><AgentTimelineSidebar agentEvents={agentEvents} projectSummaries={projectSummaries}
      connected={connected} loading={agentDataLoading} error={agentDataError} /></Suspense></div>
  </div>;
}

export default function WorkspaceShell({ children }: { children: ReactNode }) {
  return <RepoStreamProvider><WorkspaceContent>{children}</WorkspaceContent></RepoStreamProvider>;
}

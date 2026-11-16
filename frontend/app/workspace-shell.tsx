"use client";

import { Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { workspaceAttention } from "./home-next-check.mjs";
import { CodeSizeControl, PaneSeparator, paneStyle, usePaneWidth } from "./ui-preferences";
import FaviconBadge from "./favicon-badge";
import { aggregateAgentCounts } from "./home-overview.mjs";
import AgentTimelineSidebar from "./agent-timeline";
import { RepoStreamProvider, useRepoStream } from "./repo-stream";

function WorkspaceContent({ children }: { children: ReactNode }) {
  const { agentEvents, projectSummaries, connected, agentDataLoading, agentDataError } = useRepoStream();
  const [sidebarWidth, setSidebarWidth] = usePaneWidth("gitdash.agent-sidebar-width", 340);
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
  const attention = workspaceAttention(projectSummaries, agentDataLoading, agentDataError);
  return <div style={paneStyle("--agent-sidebar-width", sidebarWidth)} className={`workspace-agent-layout${collapsed ? " is-sidebar-collapsed" : ""}`}>
    <Suspense fallback={null}><FaviconBadge waiting={waitingCount} /></Suspense>
    <div className="agent-sidebar-controls"><CodeSizeControl />
      <button type="button" className="agent-timeline-pause" onClick={toggle} aria-expanded={!collapsed} aria-controls="workspace-agent-timeline">{collapsed ? "agentタイムラインを開く" : "agentタイムラインを折りたたむ"}</button>
      <span title="表示はagentの報告です。マージ準備完了は実際のマージ可否を保証しません。" role="status">{attention}{!connected && " · 再接続中"}</span>
      {storageIssue && <span role="status">開閉状態を保存・復元できません。</span>}
    </div>
    <div className="workspace-primary">{children}</div>
    {!collapsed && <PaneSeparator width={sidebarWidth} onChange={setSidebarWidth} minimum={280} label="agentサイドバーの幅" />}
    <div id="workspace-agent-timeline" className="workspace-agent-sidebar" hidden={collapsed}><Suspense fallback={<p role="status">タイムラインを読み込み中…</p>}><AgentTimelineSidebar agentEvents={agentEvents} projectSummaries={projectSummaries}
      connected={connected} loading={agentDataLoading} error={agentDataError} /></Suspense></div>
  </div>;
}

export default function WorkspaceShell({ children }: { children: ReactNode }) {
  return <RepoStreamProvider><WorkspaceContent>{children}</WorkspaceContent></RepoStreamProvider>;
}

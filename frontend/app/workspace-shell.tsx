"use client";

import type { ReactNode } from "react";
import AgentTimelineSidebar from "./agent-timeline";
import { RepoStreamProvider, useRepoStream } from "./repo-stream";

function WorkspaceContent({ children }: { children: ReactNode }) {
  const { agentEvents, projectSummaries, connected, agentDataLoading, agentDataError } = useRepoStream();
  return <div className="workspace-agent-layout">
    <div className="workspace-primary">{children}</div>
    <AgentTimelineSidebar agentEvents={agentEvents} projectSummaries={projectSummaries}
      connected={connected} loading={agentDataLoading} error={agentDataError} />
  </div>;
}

export default function WorkspaceShell({ children }: { children: ReactNode }) {
  return <RepoStreamProvider><WorkspaceContent>{children}</WorkspaceContent></RepoStreamProvider>;
}

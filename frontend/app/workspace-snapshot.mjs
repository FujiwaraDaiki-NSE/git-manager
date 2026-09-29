export function workspaceSnapshot(projects, view, capturedAt) {
  return JSON.stringify({
    format: "gitdash-projects-v1", capturedAt, view,
    projects: projects.map((project) => ({
      name: project.name, path: project.main_path, remote: project.remote,
      branches: project.lane_count, worktrees: project.worktree_count,
      git: project.git, agentState: project.agent_state,
      agentCounts: project.agent_priority_counts,
      latestCommit: project.latest_event,
      observedAt: project.latest_observed_at,
    })),
  }, null, 2);
}

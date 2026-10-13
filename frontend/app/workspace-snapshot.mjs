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

function count(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function summaryRows(projects) {
  return projects.map(project => [
    project.name, project.main_path, project.remote,
    count(project.lane_count), count(project.worktree_count),
    count(project.git?.dirty), count(project.git?.conflict),
    count(project.git?.ahead), count(project.git?.behind), project.agent_state,
  ]);
}

function csvCell(value) {
  const text = value === null || value === undefined ? "unknown" : String(value);
  const protectedText = /^[\s]*[=+\-@]/u.test(text) ? `'${text}` : text;
  return `"${protectedText.replaceAll('"', '""')}"`;
}

/** Export precisely the supplied visible rows, including the view and capture time. */
export function workspaceCsv(projects, view, capturedAt) {
  const columns = ['name', 'path', 'remote', 'branches', 'worktrees', 'dirty', 'conflict', 'ahead', 'behind', 'agent_state', 'view', 'captured_at'];
  return '\uFEFF' + [columns, ...summaryRows(projects).map(row => [...row, JSON.stringify(view), capturedAt])]
    .map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function markdownCell(value) {
  if (value === null || value === undefined) return '未取得';
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replace(/[\\`*_{}\[\]()!|]/g, '\\$&').replace(/\r\n|\r|\n/g, '<br>');
}

/** Readable report for pasting into review notes; no inferred zero counts. */
export function workspaceMarkdown(projects, view, capturedAt) {
  const columns = ['プロジェクト', 'パス', 'リモート', 'ブランチ', 'worktree', '変更あり', '競合', '未push', '未pull', 'agent状態'];
  return [
    '# gitdash プロジェクト一覧', '',
    `取得時刻: ${markdownCell(capturedAt)}`, `表示件数: ${projects.length}`, '',
    `表示条件: ${markdownCell(JSON.stringify(view))}`, '',
    `| ${columns.join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`,
    ...summaryRows(projects).map(row => `| ${row.map(markdownCell).join(' | ')} |`), '',
    'Gitの件数は該当する作業ディレクトリ数です。未取得は0件を意味しません。',
  ].join('\n');
}

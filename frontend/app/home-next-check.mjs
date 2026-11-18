import { isAcknowledged } from './agent-acknowledgements.mjs';
import { agentTaskState, compareAgentEvents } from './agent-overview.mjs';
import { currentAgentTasks } from './agent-timeline-tools.mjs';

const nextCheckPriority = { waiting_for_user: 0, blocked: 0, review_required: 1, merge_ready: 2 };

export function nextAgentCheck(project, acknowledgements) {
  if (acknowledgements === null) return null;
  return currentAgentTasks([project]).map(({ task }) => task)
    .filter((task) => Object.hasOwn(nextCheckPriority, agentTaskState(task)) && !isAcknowledged(task, acknowledgements))
    .sort((a, b) => nextCheckPriority[agentTaskState(a)] - nextCheckPriority[agentTaskState(b)] || compareAgentEvents(b, a))[0] ?? null;
}

export function workspaceAttention(projects, loading, error) {
  const prefix = '全プロジェクトの報告（確認済みを含む）：';
  if (projects.length === 0 && loading) return `${prefix}取得中…`;
  if (projects.length === 0 && error !== null) return `${prefix}取得失敗`;
  const tasks = currentAgentTasks(projects);
  const waiting = tasks.filter(({ task }) => agentTaskState(task) === 'waiting_for_user').length;
  const blocked = tasks.filter(({ task }) => agentTaskState(task) === 'blocked').length;
  return `${prefix}入力待ち ${waiting}件 · 問題あり ${blocked}件${loading ? ' · 取得中…' : error !== null ? ' · 一部未取得' : ''}`;
}

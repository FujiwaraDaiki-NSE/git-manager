import { agentReportKey, compareAgentEvents, isExplicitAgentStatus } from './agent-overview.mjs';

// Feed both snapshots/replay and live events into one branch-ordered tracker.
// Only the SSE caller may turn the returned transition into a notification.
export function createAttentionTracker() {
  const current = new Map();
  return (event) => {
    if (!isExplicitAgentStatus(event)) return false;
    const key = agentReportKey(event);
    if (key === null) return false;
    const previous = current.get(key);
    if (previous && (previous.event_id === event.event_id || compareAgentEvents(event, previous) <= 0)) return false;
    current.set(key, event);
    return previous?.status !== event.status && (event.status === 'waiting_for_user' || event.status === 'blocked');
  };
}

export function homeDocumentTitle(waiting) {
  return typeof waiting === 'number' && waiting > 0 ? `(${waiting}) 入力待ち · gitdash` : 'gitdash';
}

export function snapshotAge(observedAt, now) {
  const seconds = Math.max(0, Math.floor(now / 1000 - observedAt));
  if (seconds < 60) return '1分未満前';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}時間前`;
  return `${Math.floor(seconds / 86400)}日前`;
}

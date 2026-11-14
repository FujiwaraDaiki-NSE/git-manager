import { agentReportKey } from './agent-overview.mjs';
import { shellQuote } from './worktree-tools.mjs';

export const ACKNOWLEDGEMENTS_STORAGE_KEY = 'gitdash.agent-acknowledgements';

export function reportIdentity(task) {
  const eventId = typeof task.event_id === 'string' && task.event_id.length > 0 ? task.event_id : null;
  const sequence = Number.isSafeInteger(task.sequence) ? task.sequence : null;
  return eventId === null && sequence === null ? null : { eventId, sequence };
}

export function parseAcknowledgements(raw) {
  if (raw === null) return {};
  try {
    const value = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    for (const identity of Object.values(value)) {
      if (identity === null || typeof identity !== 'object' || Array.isArray(identity)
        || !(identity.eventId === null || typeof identity.eventId === 'string' && identity.eventId.length > 0)
        || !(identity.sequence === null || Number.isSafeInteger(identity.sequence))
        || identity.eventId === null && identity.sequence === null) return null;
    }
    return value;
  } catch { return null; }
}

export function isAcknowledged(task, acknowledgements) {
  const key = agentReportKey(task);
  const identity = reportIdentity(task);
  if (key === null || identity === null || !Object.hasOwn(acknowledgements, key)) return false;
  const saved = acknowledgements[key];
  return saved.eventId === identity.eventId && saved.sequence === identity.sequence;
}

export function agentWorktreeCommand(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) return null;
  return `cd ${shellQuote(path)}`;
}

// Bulk and individual actions use the same exact report identity. In
// particular, undoing an older report cannot clear a newer acknowledgement.
export function updateAcknowledgements(tasks, acknowledgements, acknowledged) {
  const next = { ...acknowledgements };
  for (const task of tasks) {
    const key = agentReportKey(task);
    const identity = reportIdentity(task);
    if (key === null || identity === null) continue;
    if (acknowledged) next[key] = identity;
    else if (isAcknowledged(task, next)) delete next[key];
  }
  return next;
}

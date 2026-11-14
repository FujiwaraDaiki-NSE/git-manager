import type { AgentTask } from './types';
export function createAttentionTracker(): (event: AgentTask) => boolean;
export function homeDocumentTitle(waiting: number | null): string;
export function snapshotAge(observedAt: number, now: number): string;

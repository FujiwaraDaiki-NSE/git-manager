import type { AgentTask, ProjectBranchRow } from './types';
export function timelineRowGeometry(rows: ProjectBranchRow[], eventsByRow: Map<string, unknown[]>): { rows: {top: number; height: number; center: number; compact: boolean}[]; height: number };
export function agentFreshness(occurredAt: string | null, now: number | null): 'unknown' | 'fresh' | 'recent' | 'old';
export function rowAgentReports(row: ProjectBranchRow, tasks: AgentTask[] | null): AgentTask[];
export function isUnpushedCommit(row: ProjectBranchRow, hash: string): boolean;

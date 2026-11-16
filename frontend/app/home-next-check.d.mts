import type { AgentTask, ProjectSummary } from './types';
import type { Acknowledgements } from './agent-acknowledgements.mjs';
export function nextAgentCheck(project: ProjectSummary, acknowledgements: Acknowledgements | null): AgentTask | null;
export function workspaceAttention(projects: ProjectSummary[], loading: boolean, error: string | null): string;

import type { AgentTask } from './types';
export type ReportIdentity = { eventId: string | null; sequence: number | null };
export type Acknowledgements = Record<string, ReportIdentity>;
export const ACKNOWLEDGEMENTS_STORAGE_KEY: string;
export function reportIdentity(task: AgentTask): ReportIdentity | null;
export function parseAcknowledgements(raw: string | null): Acknowledgements | null;
export function isAcknowledged(task: AgentTask, acknowledgements: Acknowledgements): boolean;
export function agentWorktreeCommand(path: string | null | undefined): string | null;
export function updateAcknowledgements(tasks: AgentTask[], acknowledgements: Acknowledgements, acknowledged: boolean): Acknowledgements;

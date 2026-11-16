import type { ProjectSummary } from './types';
type ProjectsResponse = { projects: ProjectSummary[] };
export const PROJECTS_CACHE_KEY: string;
export const PROJECTS_CACHE_VERSION: number;
export function readProjectsCache(storage: Pick<Storage, 'getItem'>): { version: number; savedAt: number; response: ProjectsResponse } | null;
export function saveProjectsCache(storage: Pick<Storage, 'setItem'>, response: ProjectsResponse, savedAt: number): void;

export type FetchProgress = { active: boolean; total: number; done: number; failed: number };
export function fetchProgressLabel(progress: FetchProgress | null): string | null;

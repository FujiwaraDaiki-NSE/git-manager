// Bump this version when the ProjectSummary response contract changes.
export const PROJECTS_CACHE_KEY = 'gitdash.projects';
export const PROJECTS_CACHE_VERSION = 1;

export function readProjectsCache(storage) {
  try {
    const value = JSON.parse(storage.getItem(PROJECTS_CACHE_KEY));
    if (value === null || value.version !== PROJECTS_CACHE_VERSION
      || !Number.isFinite(value.savedAt) || value.savedAt < 0
      || !Array.isArray(value.response?.projects)) return null;
    return value;
  } catch { return null; }
}

export function saveProjectsCache(storage, response, savedAt) {
  try {
    storage.setItem(PROJECTS_CACHE_KEY, JSON.stringify({ version: PROJECTS_CACHE_VERSION, savedAt, response }));
  } catch { /* Storage is optional; keep the live response. */ }
}

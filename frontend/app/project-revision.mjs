export function selectedProjectKey(selection, repos) {
  if (!selection) return null;
  if (selection.type === "project") return selection.commonDir;
  return repos.get(selection.path)?.common_dir ?? null;
}

export function revisionKeysForEvent(event, selection, repos) {
  if (event?.type === "repo") {
    return typeof event.repo?.common_dir === "string" && event.repo.common_dir
      ? [event.repo.common_dir]
      : [];
  }
  if (event?.type === "removed") {
    const commonDir = repos.get(event.path)?.common_dir;
    return commonDir ? [commonDir] : [];
  }
  if (event?.type === "snapshot" || event?.type === "scan-complete") {
    const commonDir = selectedProjectKey(selection, repos);
    return commonDir ? [commonDir] : [];
  }
  return [];
}

export function bumpProjectRevisions(revisions, keys) {
  const uniqueKeys = new Set(keys);
  if (!uniqueKeys.size) return revisions;
  const next = new Map(revisions);
  for (const key of uniqueKeys) next.set(key, (next.get(key) ?? 0) + 1);
  return next;
}

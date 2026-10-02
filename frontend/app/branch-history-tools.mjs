/** Search only loaded commits; never interpret missing metadata as a match. */
export function filterHistory(commits, query, kind) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return commits.filter((commit) => {
    // A missing parents field is an unknown kind. It must not be presented as
    // a regular commit just because it is not a merge.
    if (kind === "merge" && commit.isMerge !== true) return false;
    if (kind === "regular" && commit.isMerge !== false) return false;
    const text = [commit.hash, commit.subject, commit.author].filter((value) => typeof value === "string").join("\n").toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

export function sortHistory(commits, order) {
  if (order === "git") return [...commits];
  return commits.map((commit, index) => ({ commit, index })).sort((a, b) => {
    const left = a.commit.date === null ? NaN : Date.parse(a.commit.date);
    const right = b.commit.date === null ? NaN : Date.parse(b.commit.date);
    if (!Number.isFinite(left) && !Number.isFinite(right)) return a.index - b.index;
    if (!Number.isFinite(left)) return 1;
    if (!Number.isFinite(right)) return -1;
    return (order === "oldest" ? left - right : right - left) || a.index - b.index;
  }).map(({ commit }) => commit);
}

/** Fetched commit metadata is authoritative only for the selected hash. */
export function commitHeader(event, detail) {
  if (detail !== null && detail.hash === event.commit_hash) {
    return { subject: detail.subject, author: detail.author, date: detail.date };
  }
  return { subject: event.subject, author: event.author, date: event.occurred_at };
}

function csvCell(value) {
  const text = value === null ? "" : String(value);
  const safe = /^[\s]*[=+\-@]/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function historyCsv(commits) {
  return "\uFEFF" + [
    ["hash", "subject", "author", "date", "kind"],
    ...commits.map((commit) => [commit.hash, commit.subject, commit.author, commit.date, commit.isMerge === true ? "merge" : commit.isMerge === false ? "commit" : "unknown"]),
  ].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

/**
 * Identify the immutable history snapshot a page request belongs to.
 *
 * The cursor is deliberately excluded: it advances as pages are loaded, while
 * the branch/project/heads/seed data define whether a response is still valid.
 */
export function historyRequestKey(path, rowId, heads, seedHashes) {
  return JSON.stringify([path, rowId, heads, seedHashes]);
}

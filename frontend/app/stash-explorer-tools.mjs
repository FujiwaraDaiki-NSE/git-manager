/**
 * Pure helpers for the stash explorer.  Keeping search and command rendering
 * outside the React component makes the read-only contract easy to exercise
 * without mounting a browser component.
 */

/** @typedef {{ hash: string, selector: string, subject: string, date: string }} StashSummary */

/**
 * Search stash subjects and immutable hashes.  An empty query preserves Git's
 * inventory order, which is newest-first for `git stash list`.
 *
 * @param {StashSummary[]} stashes
 * @param {string} query
 * @returns {StashSummary[]}
 */
export function searchStashes(stashes, query) {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return stashes;
  return stashes.filter((stash) => [stash.subject, stash.hash].some((value) => value.toLocaleLowerCase().includes(needle)));
}

/**
 * Add the host repository path to a backend command for direct terminal use.
 * The backend command contains only fixed Git arguments and the immutable
 * object id; this helper supplies the checkout context known by the browser.
 *
 * @param {string} path
 * @param {string | null | undefined} command
 * @returns {string | null}
 */
export function stashCommand(path, command) {
  if (typeof path !== "string" || path.length === 0) return null;
  if (!command) return null;
  const quotedPath = `'${path.replaceAll("'", "'\\''")}'`;
  if (!command.startsWith("git ")) return null;
  if (/\bstash\s+(?:apply|pop|drop|clear|push|store)\b/.test(command)) return null;
  return `git -C ${quotedPath} ${command.slice(4)}`;
}

/**
 * Return a stable label for a file part in the UI.
 *
 * @param {"tracked" | "untracked"} part
 * @returns {string}
 */
export function stashPartLabel(part) {
  return part === "tracked" ? "追跡済みの変更" : "未追跡ファイル";
}


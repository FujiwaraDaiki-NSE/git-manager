/** Resolve history in row order. Missing bodies are a contract error. */
export function resolveBranchCommits(project, row) {
  return row.commit_hashes.map((hash) => {
    const commit = project.branch_commits[hash];
    if (commit === undefined) throw new Error(`Missing branch commit: ${hash}`);
    return commit;
  });
}

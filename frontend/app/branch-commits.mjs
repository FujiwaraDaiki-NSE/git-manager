/** Resolve history in row order. Missing bodies are a contract error. */
export function resolveBranchCommits(project, row) {
  return row.commit_indices.map((index) => {
    const commit = project.branch_commits?.[index];
    if (commit === undefined) throw new Error(`Missing branch commit at index: ${index}`);
    return commit;
  });
}

import type { ProjectResponse, ProjectBranchRow, ProjectBranchCommit } from "./types";
export function resolveBranchCommits(project: ProjectResponse, row: ProjectBranchRow): ProjectBranchCommit[];

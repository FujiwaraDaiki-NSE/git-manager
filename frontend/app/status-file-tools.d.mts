import type { Entry } from "./types";

export declare const STATUS_FILE_DIRECTORY_ALL: "all";
export declare const STATUS_FILE_DIRECTORY_ROOT: ".";
export declare const STATUS_FILE_EXTENSION_ALL: "all";
export declare const STATUS_FILE_EXTENSION_NONE: "none";
export declare const STATUS_FILE_ORDERS: readonly ["asc", "desc"];

export type StatusFileOrder = "asc" | "desc";
export type StatusFileDiffExclusions = {
  untracked: Entry[];
  conflicts: Entry[];
  unsupported: Entry[];
};
export type StatusFileDiffCommands = {
  staged: string | null;
  unstaged: string | null;
  excluded: StatusFileDiffExclusions;
};

export declare function statusFileDirectory(path: string): string;
export declare function statusFileExtension(path: string): string | null;
export declare function listStatusFileDirectories(entries: Entry[]): string[];
export declare function listStatusFileExtensions(entries: Entry[]): string[];
export declare function searchStatusFiles(entries: Entry[], query: string): Entry[];
export declare function filterStatusFilesByDirectory(entries: Entry[], directory: string): Entry[];
export declare function filterStatusFilesByExtension(entries: Entry[], extension: string): Entry[];
export declare function sortStatusFiles(entries: Entry[], order: StatusFileOrder): Entry[];
export declare function statusFilesCsv(entries: Entry[]): string;
export declare function shellQuote(value: string): string;
export declare function buildStatusDiffCommands(repoPath: string, entries: Entry[]): StatusFileDiffCommands;

/**
 * Pure helpers for the uncommitted file inventory in the repository status
 * pane.  Paths come from the backend's porcelain-v2 snapshot and remain
 * relative to the repository root.
 */

import { fileStatusGroups } from "./file-status.mjs";

export const STATUS_FILE_DIRECTORY_ALL = "/";
export const STATUS_FILE_DIRECTORY_ROOT = ".";
export const STATUS_FILE_EXTENSION_ALL = "all";
export const STATUS_FILE_EXTENSION_NONE = "none";
export const STATUS_FILE_ORDERS = ["asc", "desc"];

const conflictCodes = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
const changeCodes = new Set(["A", "M", "D", "R", "C", "T"]);

function pathDirectory(path) {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? STATUS_FILE_DIRECTORY_ROOT : path.slice(0, separator);
}

function pathExtension(path) {
  const separator = path.lastIndexOf("/");
  const basename = path.slice(separator + 1);
  const dot = basename.lastIndexOf(".");
  // A plain dotfile is deliberately extensionless.  A dotfile with a suffix
  // (for example .env.local) uses the final suffix as its extension.
  if (dot <= 0 || dot === basename.length - 1) return null;
  return basename.slice(dot).toLocaleLowerCase();
}

export function statusFileDirectory(path) {
  if (typeof path !== "string") {
    throw new TypeError("Status file path must be a string");
  }
  return pathDirectory(path);
}

export function statusFileExtension(path) {
  if (typeof path !== "string") {
    throw new TypeError("Status file path must be a string");
  }
  return pathExtension(path);
}

export function listStatusFileDirectories(entries) {
  const directories = new Set(entries.map((entry) => statusFileDirectory(entry.path)));
  return [...directories].sort((left, right) => {
    if (left === STATUS_FILE_DIRECTORY_ROOT) return -1;
    if (right === STATUS_FILE_DIRECTORY_ROOT) return 1;
    return left.localeCompare(right, undefined, { sensitivity: "base" });
  });
}

export function listStatusFileExtensions(entries) {
  const extensions = new Set();
  for (const entry of entries) {
    const extension = statusFileExtension(entry.path);
    extensions.add(extension === null ? STATUS_FILE_EXTENSION_NONE : extension);
  }
  return [...extensions].sort((left, right) => {
    if (left === STATUS_FILE_EXTENSION_NONE) return -1;
    if (right === STATUS_FILE_EXTENSION_NONE) return 1;
    return left.localeCompare(right, undefined, { sensitivity: "base" });
  });
}

export function searchStatusFiles(entries, query) {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return [...entries];
  return entries.filter((entry) => entry.path.toLocaleLowerCase().includes(normalized));
}

export function filterStatusFilesByDirectory(entries, directory) {
  if (typeof directory !== "string" || directory.length === 0) {
    throw new RangeError(`Unknown status file directory: ${directory}`);
  }
  if (directory === STATUS_FILE_DIRECTORY_ALL) return [...entries];
  return entries.filter((entry) => statusFileDirectory(entry.path) === directory);
}

export function filterStatusFilesByExtension(entries, extension) {
  if (typeof extension !== "string" || extension.length === 0) {
    throw new RangeError(`Unknown status file extension: ${extension}`);
  }
  if (extension === STATUS_FILE_EXTENSION_ALL) return [...entries];
  if (extension !== STATUS_FILE_EXTENSION_NONE && !extension.startsWith(".")) {
    throw new RangeError(`Unknown status file extension: ${extension}`);
  }
  return entries.filter((entry) => {
    const fileExtension = statusFileExtension(entry.path);
    return extension === STATUS_FILE_EXTENSION_NONE
      ? fileExtension === null
      : fileExtension === extension.toLocaleLowerCase();
  });
}

function compareStatusFiles(left, right) {
  const pathOrder = left.path.localeCompare(right.path, undefined, { sensitivity: "base" });
  if (pathOrder !== 0) return pathOrder;
  return left.xy.localeCompare(right.xy, undefined, { sensitivity: "base" });
}

export function sortStatusFiles(entries, order) {
  if (!STATUS_FILE_ORDERS.includes(order)) {
    throw new RangeError(`Unknown status file order: ${order}`);
  }
  const multiplier = order === "asc" ? 1 : -1;
  return [...entries].sort((left, right) => multiplier * compareStatusFiles(left, right));
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  const protectedText = /^[\s]*[=+\-@]/u.test(text) ? `'${text}` : text;
  return `"${protectedText.replaceAll('"', '""')}"`;
}

/** Export exactly the supplied visible status/path rows as formula-safe CSV. */
export function statusFilesCsv(entries) {
  const rows = [["status", "path"], ...entries.map((entry) => [entry.xy, entry.path])];
  return "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function entryKind(entry) {
  if (
    !entry
    || typeof entry.xy !== "string"
    || entry.xy.length !== 2
    || typeof entry.path !== "string"
    || entry.path.length === 0
  ) {
    return "unsupported";
  }
  if (entry.xy === "??") return "untracked";
  // The API omits the source path, so a rename cannot be represented fully.
  if (/[RC]/.test(entry.xy)) return "unsupported";
  if (conflictCodes.has(entry.xy)) return "conflict";
  if (
    (entry.xy[0] === "." || changeCodes.has(entry.xy[0]))
    && (entry.xy[1] === "." || changeCodes.has(entry.xy[1]))
    && entry.xy !== ".."
  ) {
    return "tracked";
  }
  return "unsupported";
}

export function shellQuote(value) {
  if (typeof value !== "string") throw new TypeError("Shell value must be a string");
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function literalPathspec(path) {
  // Shell quoting protects the command text; literal pathspec magic also
  // prevents Git from interpreting glob, wildcard, and colon magic.
  return shellQuote(`:(literal)${path}`);
}

function diffCommand(repoPath, mode, paths) {
  if (paths.length === 0) return null;
  const cached = mode === "staged" ? " --cached" : "";
  return `git -C ${shellQuote(repoPath)} diff${cached} -- ${paths.map(literalPathspec).join(" ")}`;
}

/**
 * Build independent, read-only diff commands for the visible tracked rows.
 * The backend exposes only the current path for a rename, so no source path
 * is guessed or synthesized here.
 */
export function buildStatusDiffCommands(repoPath, entries) {
  if (typeof repoPath !== "string" || repoPath.length === 0) {
    throw new TypeError("Repository path must be a non-empty string");
  }
  if (!Array.isArray(entries)) throw new TypeError("Status entries must be an array");

  const stagedPaths = [];
  const unstagedPaths = [];
  const stagedSeen = new Set();
  const unstagedSeen = new Set();
  const excluded = { untracked: [], conflicts: [], unsupported: [] };

  for (const entry of entries) {
    const kind = entryKind(entry);
    if (kind === "untracked") {
      excluded.untracked.push(entry);
      continue;
    }
    if (kind === "conflict") {
      excluded.conflicts.push(entry);
      continue;
    }
    if (kind !== "tracked") {
      excluded.unsupported.push(entry);
      continue;
    }

    const groups = fileStatusGroups(entry.xy);
    if (groups.staged && !stagedSeen.has(entry.path)) {
      stagedSeen.add(entry.path);
      stagedPaths.push(entry.path);
    }
    if (groups.unstaged && !unstagedSeen.has(entry.path)) {
      unstagedSeen.add(entry.path);
      unstagedPaths.push(entry.path);
    }
  }

  return {
    staged: diffCommand(repoPath, "staged", stagedPaths),
    unstaged: diffCommand(repoPath, "unstaged", unstagedPaths),
    excluded,
  };
}

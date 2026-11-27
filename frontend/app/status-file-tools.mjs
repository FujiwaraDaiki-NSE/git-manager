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
  return entries.filter((entry) => entry.path.toLocaleLowerCase().includes(normalized)
    || (entry.original_path !== null && entry.original_path.toLocaleLowerCase().includes(normalized)));
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
  // Rename/copy requires the source supplied by the status snapshot.
  if (/[RC]/.test(entry.xy) && (typeof entry.original_path !== "string" || entry.original_path.length === 0)) return "unsupported";
  if (fileStatusGroups(entry.xy).conflict) return "conflict";
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

export function buildUntrackedDirectoryCommand(repoPath, entry) {
  if (entryKind(entry) !== "untracked" || !entry.path.endsWith("/") || entry.path.includes("\uFFFD")) return null;
  return `git -C ${shellQuote(repoPath)} ls-files --others --exclude-standard -- ${literalPathspec(entry.path)}`;
}

export function buildUntrackedFileDiffCommand(repoPath, entry) {
  if (entryKind(entry) !== "untracked" || entry.path.endsWith("/") || entry.path.includes("\uFFFD")) return null;
  // Git reads stdin for a bare "-" even after "--".
  const path = entry.path === "-" ? "./-" : entry.path;
  return `git -C ${shellQuote(repoPath)} diff --no-index -- /dev/null ${shellQuote(path)}`;
}

export function canUnstageStatusFile(hasHead, entry) {
  return hasHead && entryKind(entry) === "tracked" && entry.regular_file === true
    && !/[RC]/.test(entry.xy) && fileStatusGroups(entry.xy).staged
    && !entry.path.endsWith("/") && !entry.path.includes("\uFFFD");
}

export function buildStatusUnstageCommand(repoPath, hasHead, selectedEntries, allEntries) {
  const paths = [...new Set(selectedEntries.filter((entry) => canUnstageStatusFile(hasHead, entry)).map((entry) => entry.path))]
    // Literal pathspecs still match directory descendants.
    .filter((path) => !allEntries.some((other) => other.path.startsWith(`${path}/`) || path.startsWith(`${other.path}/`)));
  if (paths.length === 0) return null;
  return `git -C ${shellQuote(repoPath)} restore --staged -- ${paths.map(literalPathspec).join(" ")}`;
}

export function statusStagePaths(entry) {
  const kind = entryKind(entry);
  if (kind !== "tracked" && kind !== "untracked") return [];
  if (entry.path.includes("\uFFFD") || (typeof entry.original_path === "string" && entry.original_path.includes("\uFFFD"))) return [];
  // Porcelain can report an entire untracked directory as one row.
  if (kind === "untracked") return entry.path.endsWith("/") ? [] : [entry.path];
  if (!fileStatusGroups(entry.xy).unstaged) return [];
  return entry.xy[1] === "R" ? [entry.original_path, entry.path] : [entry.path];
}

export function buildStatusStageCommands(repoPath, entries) {
  if (typeof repoPath !== "string" || repoPath.length === 0) {
    throw new TypeError("Repository path must be a non-empty string");
  }
  const paths = [...new Set(entries.flatMap(statusStagePaths))];
  if (paths.length === 0) return null;
  const command = `git -C ${shellQuote(repoPath)} add`;
  const pathspecs = paths.map(literalPathspec).join(" ");
  return { dryRun: `${command} --dry-run -- ${pathspecs}`, add: `${command} -- ${pathspecs}` };
}

function diffCommand(repoPath, mode, paths) {
  if (paths.length === 0) return null;
  const cached = mode === "staged" ? " --cached" : "";
  return `git -C ${shellQuote(repoPath)} diff${cached} -- ${paths.map(literalPathspec).join(" ")}`;
}

/**
 * Build independent, read-only diff commands for the visible tracked rows.
 * Include both paths only on the side reporting a rename/copy.
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
    for (const [changed, code, paths, seen] of [
      [groups.staged, entry.xy[0], stagedPaths, stagedSeen],
      [groups.unstaged, entry.xy[1], unstagedPaths, unstagedSeen],
    ]) {
      if (!changed) continue;
      const sidePaths = /[RC]/.test(code) ? [entry.original_path, entry.path] : [entry.path];
      for (const path of sidePaths) {
        if (!seen.has(path)) {
          seen.add(path);
          paths.push(path);
        }
      }
    }
  }

  return {
    staged: diffCommand(repoPath, "staged", stagedPaths),
    unstaged: diffCommand(repoPath, "unstaged", unstagedPaths),
    excluded,
  };
}

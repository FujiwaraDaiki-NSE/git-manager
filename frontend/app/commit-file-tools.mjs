/**
 * Pure helpers for the file inventory shown for a commit.
 *
 * Numstat reports `-` for a line count it cannot measure.  Binary files are
 * always treated as unknown even if a producer happens to send numeric
 * values, because the UI must not suggest that binary line counts are
 * meaningful.
 */

export const COMMIT_FILE_FILTERS = ["all", "text", "binary", "renamed"];
export const COMMIT_FILE_SORTS = ["path", "volume", "additions", "deletions"];
export const COMMIT_FILE_ORDERS = ["asc", "desc"];
export const COMMIT_FILE_DIRECTORY_ALL = "all";
export const COMMIT_FILE_DIRECTORY_ROOT = ".";
export const COMMIT_FILE_EXTENSION_ALL = "all";
export const COMMIT_FILE_EXTENSION_NONE = "none";

export function isBinaryFile(file) {
  return file.binary === true;
}

export function isRenamedFile(file) {
  return file.old_path !== undefined;
}

export function matchesCommitFileQuery(file, query) {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return true;
  return [file.path, file.old_path].some(
    (path) => typeof path === "string" && path.toLocaleLowerCase().includes(normalized),
  );
}

export function searchCommitFiles(files, query) {
  return files.filter((file) => matchesCommitFileQuery(file, query));
}

/** Return the directory of the current path. A file without a slash is in the explicit root directory. */
export function commitFileDirectory(file) {
  return pathDirectory(file.path);
}

/**
 * Return the lower-case extension of the current path, including its dot.
 * A plain dotfile such as `.gitignore`, a name without a dot, and a trailing
 * dot are deliberately treated as having no extension. A dotfile with a
 * suffix, such as `.env.local`, has the final suffix `.local`.
 */
export function commitFileExtension(file) {
  return pathExtension(file.path);
}

function pathDirectory(path) {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? COMMIT_FILE_DIRECTORY_ROOT : path.slice(0, separator);
}

function pathExtension(path) {
  const separator = path.lastIndexOf("/");
  const basename = path.slice(separator + 1);
  const dot = basename.lastIndexOf(".");
  if (dot <= 0 || dot === basename.length - 1) return null;
  return basename.slice(dot).toLocaleLowerCase();
}

function commitFilePaths(file) {
  return file.old_path === undefined || file.old_path === null
    ? [file.path]
    : [file.old_path, file.path];
}

export function listCommitFileDirectories(files) {
  const directories = new Set(files.flatMap((file) => commitFilePaths(file).map(pathDirectory)));
  return [...directories].sort((left, right) => {
    if (left === COMMIT_FILE_DIRECTORY_ROOT) return -1;
    if (right === COMMIT_FILE_DIRECTORY_ROOT) return 1;
    return left.localeCompare(right, undefined, { sensitivity: "base" });
  });
}

export function listCommitFileExtensions(files) {
  const extensions = new Set();
  for (const file of files) {
    for (const extension of commitFilePaths(file).map(pathExtension)) {
      extensions.add(extension === null ? COMMIT_FILE_EXTENSION_NONE : extension);
    }
  }
  return [...extensions].sort((left, right) => {
    if (left === COMMIT_FILE_EXTENSION_NONE) return -1;
    if (right === COMMIT_FILE_EXTENSION_NONE) return 1;
    return left.localeCompare(right, undefined, { sensitivity: "base" });
  });
}

export function filterCommitFilesByDirectory(files, directory) {
  if (typeof directory !== "string" || directory.length === 0) {
    throw new RangeError(`Unknown commit file directory: ${directory}`);
  }
  if (directory === COMMIT_FILE_DIRECTORY_ALL) return [...files];
  // A rename has two displayed paths, so either actual directory can match.
  return files.filter((file) => commitFilePaths(file).some((path) => pathDirectory(path) === directory));
}

export function filterCommitFilesByExtension(files, extension) {
  if (typeof extension !== "string" || extension.length === 0) {
    throw new RangeError(`Unknown commit file extension: ${extension}`);
  }
  if (extension === COMMIT_FILE_EXTENSION_ALL) return [...files];
  if (extension !== COMMIT_FILE_EXTENSION_NONE && !extension.startsWith(".")) {
    throw new RangeError(`Unknown commit file extension: ${extension}`);
  }
  // A rename has two displayed paths, so either actual extension can match.
  return files.filter((file) => {
    return commitFilePaths(file).some((path) => {
      const fileExtension = pathExtension(path);
      return extension === COMMIT_FILE_EXTENSION_NONE
        ? fileExtension === null
        : fileExtension === extension.toLocaleLowerCase();
    });
  });
}

export function filterCommitFiles(files, filter) {
  if (!COMMIT_FILE_FILTERS.includes(filter)) {
    throw new RangeError(`Unknown commit file filter: ${filter}`);
  }
  if (filter === "all") return [...files];
  if (filter === "binary") return files.filter(isBinaryFile);
  if (filter === "renamed") return files.filter(isRenamedFile);
  return files.filter((file) => !isBinaryFile(file));
}

export function countCommitFileKinds(files) {
  return {
    all: files.length,
    text: files.filter((file) => !isBinaryFile(file)).length,
    binary: files.filter(isBinaryFile).length,
    renamed: files.filter(isRenamedFile).length,
  };
}

/** Return a numeric volume, or null when either line count is unknown. */
export function commitFileChangeVolume(file) {
  if (isBinaryFile(file)) return null;
  if (typeof file.additions !== "number" || typeof file.deletions !== "number") return null;
  return file.additions + file.deletions;
}

function comparePath(a, b) {
  const pathOrder = a.path.localeCompare(b.path, undefined, { sensitivity: "base" });
  if (pathOrder !== 0) return pathOrder;
  const oldA = a.old_path ?? "";
  const oldB = b.old_path ?? "";
  return oldA.localeCompare(oldB, undefined, { sensitivity: "base" });
}

function commitFileSortValue(file, sort) {
  if (sort === "volume") return commitFileChangeVolume(file);
  if (sort === "additions" || sort === "deletions") {
    if (isBinaryFile(file) || typeof file[sort] !== "number") return null;
    return file[sort];
  }
  return null;
}

export function sortCommitFiles(files, sort, order) {
  if (!COMMIT_FILE_SORTS.includes(sort)) {
    throw new RangeError(`Unknown commit file sort: ${sort}`);
  }
  if (!COMMIT_FILE_ORDERS.includes(order)) {
    throw new RangeError(`Unknown commit file order: ${order}`);
  }
  const multiplier = order === "asc" ? 1 : -1;
  return [...files].sort((a, b) => {
    if (sort === "path") return multiplier * comparePath(a, b);
    const valueA = commitFileSortValue(a, sort);
    const valueB = commitFileSortValue(b, sort);
    // Unknown values are deliberately kept together at the end.  They are
    // never compared as zero, which would make binary files look unchanged.
    if (valueA === null && valueB !== null) return 1;
    if (valueA !== null && valueB === null) return -1;
    if (valueA !== null && valueB !== null && valueA !== valueB) {
      return multiplier * (valueA - valueB);
    }
    return multiplier * comparePath(a, b);
  });
}

export function summarizeCommitFiles(files) {
  let additions = 0;
  let deletions = 0;
  let unknownAdditions = false;
  let unknownDeletions = false;
  for (const file of files) {
    if (isBinaryFile(file) || typeof file.additions !== "number") unknownAdditions = true;
    else additions += file.additions;
    if (isBinaryFile(file) || typeof file.deletions !== "number") unknownDeletions = true;
    else deletions += file.deletions;
  }
  return {
    files: files.length,
    additions,
    deletions,
    binary: files.filter(isBinaryFile).length,
    renamed: files.filter(isRenamedFile).length,
    unknownAdditions,
    unknownDeletions,
  };
}

export function displayCommitFileCount(file, side) {
  if (side !== "additions" && side !== "deletions") {
    throw new RangeError(`Unknown numstat side: ${side}`);
  }
  const value = file[side];
  if (isBinaryFile(file) || value === "-") return "不明";
  return String(value);
}

/**
 * Prefix values that spreadsheet applications may interpret as formulas.
 * Keeping the apostrophe in the exported text makes the protection visible
 * and works in common spreadsheet applications without changing the path.
 */
export function escapeSpreadsheetFormula(value) {
  const text = String(value);
  return /^[=+\-@\t\r\n]/.test(text) ? `'${text}` : text;
}

function tsvCell(value) {
  const safe = escapeSpreadsheetFormula(value);
  return /["\t\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function exportNumstatValue(file, side) {
  const value = file[side];
  return isBinaryFile(file) || value === "-" ? "unknown" : String(value);
}

/** Build a spreadsheet-safe TSV inventory for the supplied (possibly filtered) files. */
export function buildCommitFilesTsv(files) {
  const rows = [
    ["path", "oldpath", "additions", "deletions", "binary"],
    ...files.map((file) => [
      file.path,
      file.old_path === undefined ? "" : file.old_path,
      exportNumstatValue(file, "additions"),
      exportNumstatValue(file, "deletions"),
      file.binary ? "true" : "false",
    ]),
  ];
  return `${rows.map((row) => row.map(tsvCell).join("\t")).join("\r\n")}\r\n`;
}

/** Build one current path per line for the supplied (possibly filtered) files. */
export function buildCommitFilesPathList(files) {
  return files.map((file) => file.path).join("\n");
}

export { tsvCell as escapeTsvCell };

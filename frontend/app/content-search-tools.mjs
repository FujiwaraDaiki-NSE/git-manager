function requiredString(value, name) {
  if (typeof value !== "string") throw new TypeError(`${name} must be provided explicitly`);
  return value;
}

function requiredBoolean(value, name) {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be provided explicitly`);
  return value;
}

/** Build a request with every content-search input present, including empty directory. */
export function contentSearchQuery(path, revision, query, caseSensitive, directory) {
  requiredString(path, "path");
  requiredString(revision, "revision");
  requiredString(query, "query");
  requiredBoolean(caseSensitive, "caseSensitive");
  requiredString(directory, "directory");
  return new URLSearchParams({
    path,
    revision,
    query,
    caseSensitive: String(caseSensitive),
    directory,
  }).toString();
}

/** Keep a response tied to one explicit repository investigation. */
export function contentSearchRequestKey(path, revision, query, caseSensitive, directory) {
  if ([path, revision, query, directory].some((value) => typeof value !== "string") || typeof caseSensitive !== "boolean") return null;
  return JSON.stringify([path, revision, query, caseSensitive, directory]);
}

/** Build the pinned blob request used by the selected-match preview. */
export function contentSearchFileQuery(path, revision, file) {
  requiredString(path, "path");
  requiredString(revision, "revision");
  requiredString(file, "file");
  return new URLSearchParams({ path, revision, file }).toString();
}

/**
 * Return a small line-numbered window around one server-reported match.
 * The caller supplies the complete text fetched at the same pinned hash.
 */
export function contentSearchContext(text, highlightLine, radius) {
  requiredString(text, "text");
  if (!Number.isInteger(highlightLine) || highlightLine < 1) throw new TypeError("highlightLine must be a positive integer");
  if (!Number.isInteger(radius) || radius < 0) throw new TypeError("radius must be a non-negative integer");
  // A trailing newline terminates the last line; it does not create a new
  // numbered line in the preview.  Preserve intentional blank lines before
  // that terminator.
  const source = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  const start = Math.max(1, highlightLine - radius);
  const end = Math.min(source.length, highlightLine + radius);
  return {
    start,
    end,
    lines: source.slice(start - 1, end).map((line, index) => ({
      line: start + index,
      text: line,
      highlight: start + index === highlightLine,
    })),
  };
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  // Spreadsheet applications may evaluate cells beginning with these
  // characters.  Prefixing a quote keeps the exported value as text.
  const safe = /^[\s]*[=+\-@]/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

/** Export exactly the matching lines, preserving multiline paths and text. */
export function contentSearchCsv(matches) {
  if (!Array.isArray(matches)) throw new TypeError("matches must be an array");
  return "\uFEFF" + [
    ["path", "line", "text"],
    ...matches.map((match) => [match?.path, match?.line, match?.text]),
  ].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

/**
 * Link to the existing file-history investigation with the immutable search
 * hash already filled in.  FileHistoryExplorer reads the values but waits
 * for the user to press its explicit fetch button.
 */
export function buildContentSearchFileHistoryHref(href, path, revision, file, follow) {
  requiredString(href, "href");
  requiredString(path, "path");
  requiredString(revision, "revision");
  requiredString(file, "file");
  requiredBoolean(follow, "follow");
  if (!/^[0-9a-f]{40,64}$/iu.test(revision)) throw new TypeError("revision must be a full resolved hash");
  if (!file) throw new TypeError("file must be a non-empty path");
  const url = new URL(href, "http://localhost");
  url.searchParams.set("path", path);
  url.searchParams.set("tab", "info");
  for (const key of ["investigation", "investigationBase", "investigationTarget", "investigationMode", "investigationRevision", "investigationFile", "investigationFollow"]) url.searchParams.delete(key);
  url.searchParams.set("investigation", "file-history");
  url.searchParams.set("investigationRevision", revision);
  url.searchParams.set("investigationFile", file);
  url.searchParams.set("investigationFollow", String(follow));
  return /^[a-z][a-z\d+.-]*:/iu.test(href) ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
}

export function contentSearchMatchKey(match, index) {
  if (!match || typeof match !== "object") throw new TypeError("match must be provided explicitly");
  if (typeof match.path !== "string" || !Number.isInteger(match.line)) throw new TypeError("match path and line are required");
  if (!Number.isInteger(index) || index < 0) throw new TypeError("index must be a non-negative integer");
  return `${match.path}:${match.line}:${index}`;
}

// Short aliases make focused helper tests and small consumers convenient
// while keeping the descriptive exports above as the public contract.
export const contentQuery = contentSearchQuery;
export const contentRequestKey = contentSearchRequestKey;
export const contentCsv = contentSearchCsv;
export const contentContext = contentSearchContext;

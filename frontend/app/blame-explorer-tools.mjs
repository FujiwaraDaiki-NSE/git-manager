export const UNKNOWN_BLAME_AUTHOR_FILTER = "__gitdash_blame_unknown_author__";
export const BLAME_AUTHOR_FILTER_PREFIX = "__gitdash_blame_author__:";
export const MAX_BLAME_LINES = 1000;

function knownString(value) {
  return typeof value === "string" && value.length > 0;
}

function decodeAuthorFilter(value) {
  if (!value.startsWith(BLAME_AUTHOR_FILTER_PREFIX)) return { valid: true, value };
  const encoded = value.slice(BLAME_AUTHOR_FILTER_PREFIX.length);
  if (!encoded) return { valid: false, value: null };
  try {
    const decoded = decodeURIComponent(encoded);
    return { valid: knownString(decoded), value: decoded };
  } catch {
    return { valid: false, value: null };
  }
}

function assertLines(lines) {
  if (!Array.isArray(lines)) throw new TypeError("lines must be an array");
  return lines;
}

/** Return author values that actually occur in the retrieved attribution. */
export function blameAuthors(lines) {
  return Array.from(new Set(assertLines(lines).filter((line) => knownString(line.author)).map((line) => line.author)))
    .sort((left, right) => left.localeCompare(right));
}

export function blameCommits(lines) {
  return Array.from(new Set(assertLines(lines).filter((line) => knownString(line.commit)).map((line) => line.commit)));
}

export function hasUnknownBlameAuthor(lines) {
  return assertLines(lines).some((line) => !knownString(line.author));
}

export function encodeBlameAuthor(author) {
  if (!knownString(author)) throw new TypeError("author must be a non-empty string");
  return `${BLAME_AUTHOR_FILTER_PREFIX}${encodeURIComponent(author)}`;
}

/**
 * Filter only rows already returned by the current blame request.
 * ``authorFilter`` and ``commitFilter`` are exact matches; query is a
 * whitespace-separated case-insensitive search over the visible row fields.
 */
export function filterBlameLines(lines, query, authorFilter, commitFilter) {
  assertLines(lines);
  if (typeof query !== "string" || typeof authorFilter !== "string" || typeof commitFilter !== "string") {
    throw new TypeError("lines, query, authorFilter, and commitFilter must be provided explicitly");
  }
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const authorActive = authorFilter !== "";
  const decodedAuthor = authorActive && authorFilter !== UNKNOWN_BLAME_AUTHOR_FILTER
    ? decodeAuthorFilter(authorFilter)
    : { valid: true, value: null };
  if (authorActive && authorFilter !== UNKNOWN_BLAME_AUTHOR_FILTER && !decodedAuthor.valid) return [];
  return lines.filter((line) => {
    if (authorActive) {
      if (authorFilter === UNKNOWN_BLAME_AUTHOR_FILTER) {
        if (knownString(line.author)) return false;
      } else if (line.author !== decodedAuthor.value) {
        return false;
      }
    }
    if (commitFilter !== "" && line.commit !== commitFilter) return false;
    const text = [line.final_line, line.original_line, line.commit, line.author, line.email, line.time, line.content, line.summary, line.path]
      .filter((value) => value !== null && value !== undefined)
      .join("\n")
      .toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  // Spreadsheet applications may evaluate cells beginning with these
  // characters.  Prefixing a quote keeps the exported value as text.
  const safe = /^[\s]*[=+\-@]/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

/** Export exactly the current filtered rows, including multiline content. */
export function blameCsv(lines) {
  return "\uFEFF" + [
    ["final_line", "original_line", "commit", "author", "email", "time", "content", "summary", "path"],
    ...assertLines(lines).map((line) => [
      line.final_line,
      line.original_line,
      line.commit,
      line.author,
      line.email,
      line.time,
      line.content,
      line.summary,
      line.path,
    ]),
  ].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

export function blameHashList(lines) {
  return assertLines(lines).map((line) => line.commit).join("\n");
}

/** Keep every API input tied to one explicit repository investigation. */
export function blameRequestKey(path, revision, file, start, end) {
  if ([path, revision, file].some((value) => typeof value !== "string") || !validRange(start, end)) return null;
  return JSON.stringify([path, revision, file, start, end]);
}

/** All endpoint inputs are explicit, including both ends of the range. */
export function blameQuery(path, revision, file, start, end) {
  if ([path, revision, file].some((value) => typeof value !== "string") || !validRange(start, end)) {
    throw new TypeError("path, revision, file, start, and end must be provided explicitly");
  }
  return new URLSearchParams({ path, revision, file, start: String(start), end: String(end) }).toString();
}

function validRange(start, end) {
  return Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start && end - start + 1 <= MAX_BLAME_LINES;
}

export function blameTime(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "日時未取得";
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? "日時未取得" : date.toLocaleString("ja-JP");
}

// Short aliases make the helpers convenient in focused UI tests.
export const UNKNOWN_AUTHOR_FILTER = UNKNOWN_BLAME_AUTHOR_FILTER;
export const encodeAuthor = encodeBlameAuthor;
export const authors = blameAuthors;
export const commits = blameCommits;
export const filterLines = filterBlameLines;
export const csv = blameCsv;

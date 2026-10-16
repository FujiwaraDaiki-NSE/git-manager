export const UNKNOWN_FILE_HISTORY_AUTHOR_FILTER = "__gitdash_file_history_unknown_author__";
export const FILE_HISTORY_AUTHOR_FILTER_PREFIX = "__gitdash_file_history_author__:";

function knownAuthor(value) {
  return typeof value === "string" && value.length > 0;
}

function authorFilterValue(value) {
  if (typeof value !== "string" || !value.startsWith(FILE_HISTORY_AUTHOR_FILTER_PREFIX)) {
    return { valid: true, value };
  }
  const encoded = value.slice(FILE_HISTORY_AUTHOR_FILTER_PREFIX.length);
  if (!encoded) return { valid: false, value: null };
  try {
    const decoded = decodeURIComponent(encoded);
    return { valid: knownAuthor(decoded), value: decoded };
  } catch {
    return { valid: false, value: null };
  }
}

/** Return only author values actually present in the retrieved records. */
export function fileHistoryAuthors(records) {
  return Array.from(new Set(records.filter((record) => knownAuthor(record.author)).map((record) => record.author)))
    .sort((left, right) => left.localeCompare(right));
}

export function hasUnknownFileHistoryAuthor(records) {
  return records.some((record) => !knownAuthor(record.author));
}

/** Encode a known author so an exact match cannot collide with the unknown token. */
export function encodeFileHistoryAuthor(author) {
  if (!knownAuthor(author)) throw new TypeError("author must be a non-empty string");
  return `${FILE_HISTORY_AUTHOR_FILTER_PREFIX}${encodeURIComponent(author)}`;
}

/** Filter only records already retrieved by the current history requests. */
export function filterFileHistory(records, query, authorFilter) {
  if (authorFilter === undefined) {
    throw new TypeError("authorFilter must be provided explicitly; use an empty string for no filter");
  }
  const terms = (typeof query === "string" ? query : "").trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const active = authorFilter !== null && authorFilter !== "";
  const decoded = active && authorFilter !== UNKNOWN_FILE_HISTORY_AUTHOR_FILTER
    ? authorFilterValue(authorFilter)
    : { valid: true, value: null };
  if (active && authorFilter !== UNKNOWN_FILE_HISTORY_AUTHOR_FILTER && !decoded.valid) return [];
  return records.filter((record) => {
    if (active) {
      if (authorFilter === UNKNOWN_FILE_HISTORY_AUTHOR_FILTER) {
        if (knownAuthor(record.author)) return false;
      } else if (record.author !== decoded.value) {
        return false;
      }
    }
    const text = [record.hash, record.subject, record.author, record.path, record.old_path]
      .filter((value) => typeof value === "string")
      .join("\n")
      .toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  // Spreadsheet applications may evaluate cells beginning with these
  // characters.  Prefixing a quote preserves the displayed text as data.
  const safe = /^[\s]*[=+\-@]/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

/** Export exactly the matching records, preserving multiline paths and text. */
export function fileHistoryCsv(records) {
  return "\uFEFF" + [
    ["hash", "subject", "author", "date", "status", "path", "old_path"],
    ...records.map((record) => [
      record.hash,
      record.subject,
      record.author,
      record.date,
      record.status,
      record.path,
      record.old_path,
    ]),
  ].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

export function fileHistoryHashList(records) {
  return records.map((record) => record.hash).join("\n");
}

/** Keep pagination requests tied to one explicit repository investigation. */
export function fileHistoryRequestKey(path, revision, file, follow) {
  if ([path, revision, file].some((value) => typeof value !== "string") || typeof follow !== "boolean") return null;
  return JSON.stringify([path, revision, file, follow]);
}

/** All API inputs are explicit, including the boolean and offset. */
export function fileHistoryQuery(path, revision, file, follow, offset) {
  if ([path, revision, file].some((value) => typeof value !== "string") || typeof follow !== "boolean" || !Number.isInteger(offset) || offset < 0) {
    throw new TypeError("path, revision, file, follow, and offset must be provided explicitly");
  }
  return new URLSearchParams({ path, revision, file, follow: String(follow), offset: String(offset) }).toString();
}

// Short aliases mirror the branch-history helpers and keep this module easy
// to consume from small UI tests without hiding the file-history prefix.
export const UNKNOWN_AUTHOR_FILTER = UNKNOWN_FILE_HISTORY_AUTHOR_FILTER;
export const encodeHistoryAuthor = encodeFileHistoryAuthor;
export const historyAuthors = fileHistoryAuthors;
export const hasUnknownAuthor = hasUnknownFileHistoryAuthor;
export const historyCsv = fileHistoryCsv;


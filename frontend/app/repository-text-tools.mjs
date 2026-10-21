import {
  boundedRepositoryText as boundedRepositoryFileText,
  REPOSITORY_FILES_MAX_PREVIEW_BYTES,
} from "./repository-files-tools.mjs";

export const REPOSITORY_TEXT_MAX_PREVIEW_BYTES = REPOSITORY_FILES_MAX_PREVIEW_BYTES;
export const REPOSITORY_TEXT_PAGE_LINES = 300;

function requiredString(value, name) {
  if (typeof value !== "string") throw new TypeError(`${name} must be provided explicitly`);
  return value;
}

function requiredLineCount(value) {
  if (!Number.isInteger(value) || value < 0) throw new TypeError("lineCount must be a non-negative integer");
  return value;
}

/**
 * Limit a preview by UTF-8 bytes while keeping the returned JavaScript string valid.
 * The caller must pass the byte limit explicitly so a hidden cap is never inferred.
 */
export function boundedRepositoryText(text, maxBytes) {
  requiredString(text, "text");
  if (!Number.isInteger(maxBytes) || maxBytes < 0) throw new TypeError("maxBytes must be a non-negative integer");
  return boundedRepositoryFileText(text, maxBytes);
}

/**
 * Split text into display rows while retaining exact source offsets and line endings.
 * `end` excludes the line ending; `rawEnd` includes it for lossless range copies.
 */
export function splitRepositoryText(text) {
  requiredString(text, "text");
  const lines = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = cursor;
    while (cursor < text.length && text[cursor] !== "\r" && text[cursor] !== "\n") cursor += 1;
    const end = cursor;
    let ending = "";
    if (cursor < text.length) {
      if (text[cursor] === "\r" && text[cursor + 1] === "\n") {
        ending = "\r\n";
        cursor += 2;
      } else {
        ending = text[cursor];
        cursor += 1;
      }
    }
    lines.push({
      number: lines.length + 1,
      text: text.slice(start, end),
      start,
      end,
      rawEnd: cursor,
      ending,
    });
  }
  return lines;
}

/** Parse a 1-based line number, returning null for every invalid or empty value. */
export function parseRepositoryLineNumber(value, lineCount) {
  requiredLineCount(lineCount);
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number <= lineCount ? number : null;
}

/** Validate both range endpoints without choosing an implicit endpoint. */
export function validateRepositoryTextRange(start, end, lineCount) {
  requiredLineCount(lineCount);
  const first = parseRepositoryLineNumber(start, lineCount);
  const last = parseRepositoryLineNumber(end, lineCount);
  if (first === null || last === null || first > last) return null;
  return { start: first, end: last };
}

/** Return an exact, line-inclusive range from the original text, or null when invalid. */
export function repositoryTextRange(text, start, end) {
  requiredString(text, "text");
  const lines = splitRepositoryText(text);
  const range = validateRepositoryTextRange(start, end, lines.length);
  if (range === null) return null;
  const first = lines[range.start - 1];
  const last = lines[range.end - 1];
  return {
    start: range.start,
    end: range.end,
    text: text.slice(first.start, last.rawEnd),
  };
}

/** Find every non-overlapping literal occurrence, preserving UTF-16 source offsets. */
export function findRepositoryTextMatches(text, query, caseSensitive) {
  requiredString(text, "text");
  requiredString(query, "query");
  if (typeof caseSensitive !== "boolean") throw new TypeError("caseSensitive must be provided explicitly");
  if (query === "") return [];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(escaped, caseSensitive ? "gu" : "giu");
  const matches = [];
  let occurrence;
  while ((occurrence = pattern.exec(text)) !== null) {
    const length = occurrence[0].length;
    if (length === 0) {
      pattern.lastIndex += 1;
      continue;
    }
    matches.push({ offset: occurrence.index, length, end: occurrence.index + length });
  }
  return matches;
}

/** Return the 1-based row containing a source offset, or null when there are no rows. */
export function repositoryTextLineAtOffset(lines, offset) {
  if (!Array.isArray(lines)) throw new TypeError("lines must be provided explicitly");
  if (!Number.isInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative integer");
  if (lines.length === 0) return null;
  for (const line of lines) {
    if (offset < line.rawEnd) return line.number;
  }
  return lines[lines.length - 1].number;
}

/** Convert only the visual representation; callers must keep the original text for copying. */
export function visibleRepositoryWhitespace(value, visible) {
  requiredString(value, "value");
  if (typeof visible !== "boolean") throw new TypeError("visible must be provided explicitly");
  return visible ? value.replaceAll(" ", "·").replaceAll("\t", "⇥") : value;
}

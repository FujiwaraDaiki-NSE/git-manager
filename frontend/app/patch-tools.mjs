/**
 * Helpers for the patch viewer. These functions deliberately operate on the
 * parsed patch model and the original patch string separately: line metadata
 * is useful for rendering, while the original string is the only safe source
 * for a lossless per-file copy.
 */

/** @typedef {{ text: string, kind: string, oldLine: number | null, newLine: number | null }} PatchLine */
/** @typedef {{ title: string, lines: PatchLine[] }} PatchSection */
/** @typedef {{ sectionIndex: number, lineIndex: number, offset: number, length: number, id: string }} PatchMatch */

const DIFF_HEADER = /^diff --(?:git|cc|combined) /gm;
const BINARY_LINE = /^(?:Binary files .* differ|GIT binary patch|literal \d+|delta \d+)\r?$/i;

/**
 * Return the exact substring belonging to each parsed file section.
 *
 * `parsePatch` intentionally stores lines rather than source offsets. Splitting
 * the original source at the same diff headers keeps CRLF, a final newline,
 * and any preamble bytes intact for clipboard operations.
 *
 * @param {string} patch
 * @returns {string[]}
 */
export function splitPatchByFile(patch) {
  if (patch === "") return [];
  const starts = [];
  DIFF_HEADER.lastIndex = 0;
  let match;
  while ((match = DIFF_HEADER.exec(patch)) !== null) starts.push(match.index);
  if (starts.length === 0) return [patch];

  const chunks = [];
  if (starts[0] > 0) chunks.push(patch.slice(0, starts[0]));
  for (let index = 0; index < starts.length; index += 1) {
    const end = index + 1 < starts.length ? starts[index + 1] : patch.length;
    chunks.push(patch.slice(starts[index], end));
  }
  return chunks;
}

/**
 * @param {PatchSection} section
 * @returns {{ additions: number, deletions: number, binary: boolean, hasTextLines: boolean }}
 */
export function summarizePatchSection(section) {
  let additions = 0;
  let deletions = 0;
  let binary = false;
  let hasTextLines = false;
  for (const line of section.lines) {
    if (line.kind === "addition") additions += 1;
    if (line.kind === "deletion") deletions += 1;
    if (BINARY_LINE.test(line.text)) binary = true;
    if (line.kind === "context" || line.kind === "addition" || line.kind === "deletion") hasTextLines = true;
  }
  return { additions, deletions, binary, hasTextLines };
}

/**
 * Keep hunk headers and metadata while removing ordinary context lines.
 * The original line objects, including their old/new line numbers, are kept.
 *
 * @param {PatchLine[]} lines
 * @param {boolean} changedOnly
 * @returns {PatchLine[]}
 */
export function selectPatchLines(lines, changedOnly) {
  return changedOnly ? lines.filter((line) => line.kind !== "context") : lines;
}

/** Keep source indexes attached to rows through filtering and pagination.
 * @param {PatchLine[]} lines
 * @param {boolean} changedOnly
 */
export function selectPatchRows(lines, changedOnly) {
  const rows = [];
  lines.forEach((line, lineIndex) => {
    if (!changedOnly || line.kind !== "context") rows.push({ line, lineIndex });
  });
  return rows;
}

/**
 * Find every non-overlapping occurrence in rendered patch lines. Matches are
 * line based so a search result always has a concrete row to reveal, including
 * rows beyond the initial pagination window.
 *
 * @param {PatchSection[]} sections
 * @param {string} query
 * @param {{ changedOnly?: boolean, sectionIndexes?: number[], caseSensitive?: boolean, wholeWord?: boolean }} options
 * @returns {PatchMatch[]}
 */
export function findPatchMatches(sections, query, options) {
  const needle = query.trim();
  if (needle === "") return [];
  // Escape literal input, rather than exposing regular-expression syntax. Match
  // against original text so Unicode case folding cannot shift source offsets.
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(escaped, options.caseSensitive === true ? "gu" : "giu");
  // Code identifiers include Unicode letters, marks, numbers, connectors and $.
  const wordEnd = /[\p{L}\p{M}\p{N}\p{Pc}$]$/u;
  const wordStart = /^[\p{L}\p{M}\p{N}\p{Pc}$]/u;
  const changedOnly = options.changedOnly === true;
  const allowed = options.sectionIndexes === undefined ? null : new Set(options.sectionIndexes);
  const matches = [];
  sections.forEach((section, sectionIndex) => {
    if (allowed !== null && !allowed.has(sectionIndex)) return;
    for (let lineIndex = 0; lineIndex < section.lines.length; lineIndex += 1) {
      const line = section.lines[lineIndex];
      if (changedOnly && line.kind === "context") continue;
      pattern.lastIndex = 0;
      let occurrence;
      while ((occurrence = pattern.exec(line.text)) !== null) {
        const found = occurrence.index;
        const length = occurrence[0].length;
        if (options.wholeWord === true && (
          wordEnd.test(line.text.slice(Math.max(0, found - 2), found)) ||
          wordStart.test(line.text.slice(found + length, found + length + 2))
        )) continue;
        matches.push({
          sectionIndex,
          lineIndex,
          offset: found,
          length,
          id: `${sectionIndex}:${lineIndex}:${found}`,
        });
      }
    }
  });
  return matches;
}

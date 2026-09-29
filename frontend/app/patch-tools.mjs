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

/**
 * Find every non-overlapping occurrence in rendered patch lines. Matches are
 * line based so a search result always has a concrete row to reveal, including
 * rows beyond the initial pagination window.
 *
 * @param {PatchSection[]} sections
 * @param {string} query
 * @param {{ changedOnly?: boolean, sectionIndexes?: number[] }} options
 * @returns {PatchMatch[]}
 */
export function findPatchMatches(sections, query, options) {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return [];
  const changedOnly = options.changedOnly === true;
  const allowed = options.sectionIndexes === undefined ? null : new Set(options.sectionIndexes);
  const matches = [];
  sections.forEach((section, sectionIndex) => {
    if (allowed !== null && !allowed.has(sectionIndex)) return;
    const lines = selectPatchLines(section.lines, changedOnly);
    for (const line of lines) {
      const haystack = line.text.toLocaleLowerCase();
      let offset = 0;
      while (offset <= haystack.length - needle.length) {
        const found = haystack.indexOf(needle, offset);
        if (found < 0) break;
        matches.push({
          sectionIndex,
          lineIndex: section.lines.indexOf(line),
          offset: found,
          length: needle.length,
          id: `${sectionIndex}:${section.lines.indexOf(line)}:${found}`,
        });
        offset = found + needle.length;
      }
    }
  });
  return matches;
}

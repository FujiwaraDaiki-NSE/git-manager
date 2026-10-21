/**
 * Pure helpers for the multi-file patch review controls.
 *
 * Parsed sections retain their original index so presentation order can change
 * without changing search scope, review marks, or the order of an exported
 * patch. Raw section strings are kept separate because the parsed line model
 * cannot preserve every source byte.
 */

import { summarizePatchSection } from "./patch-tools.mjs";

export const PATCH_REVIEW_FILE_KINDS = ["all", "text", "binary"];
export const PATCH_REVIEW_FILE_SORTS = ["original", "path", "changes"];

/**
 * @typedef {{ title: string, lines: Array<{ text: string, kind: string, oldLine: number | null, newLine: number | null }> }} PatchReviewSection
 * @typedef {{ section: PatchReviewSection, index: number }} PatchReviewEntry
 */

/**
 * Classify only what the parsed patch proves.
 *
 * Binary markers take precedence. A non-binary section is a text change only
 * when the parser found at least one added or deleted line. Metadata-only
 * sections remain `other` and are therefore available from the `all` filter
 * without being mislabeled as text or binary.
 *
 * @param {PatchReviewSection} section
 * @returns {"text" | "binary" | "other"}
 */
export function classifyPatchSection(section) {
  const summary = summarizePatchSection(section);
  if (summary.binary) return "binary";
  if (summary.additions > 0 || summary.deletions > 0) return "text";
  return "other";
}

/**
 * @param {PatchReviewEntry[]} entries
 * @param {string} kind
 * @returns {PatchReviewEntry[]}
 */
export function filterPatchReviewEntries(entries, kind) {
  assertEntries(entries);
  assertChoice(PATCH_REVIEW_FILE_KINDS, kind, "file kind");
  if (kind === "all") return [...entries];
  return entries.filter(({ section }) => classifyPatchSection(section) === kind);
}

/**
 * Sort entries while retaining their original section indexes. The changes
 * sort intentionally puts the largest changes first; equal values retain the
 * original patch order for predictable review navigation.
 *
 * @param {PatchReviewEntry[]} entries
 * @param {string} sort
 * @returns {PatchReviewEntry[]}
 */
export function sortPatchReviewEntries(entries, sort) {
  assertEntries(entries);
  assertChoice(PATCH_REVIEW_FILE_SORTS, sort, "file sort");
  if (sort === "original") return [...entries];
  return [...entries].sort((left, right) => {
    if (sort === "path") {
      const pathOrder = left.section.title.localeCompare(right.section.title, undefined, { sensitivity: "base" });
      return pathOrder !== 0 ? pathOrder : left.index - right.index;
    }
    const leftSummary = summarizePatchSection(left.section);
    const rightSummary = summarizePatchSection(right.section);
    const leftChanges = leftSummary.binary || !leftSummary.hasTextLines ? null : leftSummary.additions + leftSummary.deletions;
    const rightChanges = rightSummary.binary || !rightSummary.hasTextLines ? null : rightSummary.additions + rightSummary.deletions;
    if (leftChanges === null && rightChanges !== null) return 1;
    if (leftChanges !== null && rightChanges === null) return -1;
    return rightChanges !== leftChanges ? rightChanges - leftChanges : left.index - right.index;
  });
}

/**
 * Build a lossless patch from the currently visible entries. Entries are
 * sorted back into source order before joining, so a display sort never
 * changes the exported patch's original file order.
 *
 * @param {string[]} sectionPatches
 * @param {PatchReviewEntry[]} entries
 * @returns {string}
 */
export function buildVisiblePatch(sectionPatches, entries) {
  if (!Array.isArray(sectionPatches) || sectionPatches.some((chunk) => typeof chunk !== "string")) {
    throw new TypeError("sectionPatches must be an array of strings");
  }
  assertEntries(entries);
  const indexes = entries.map(({ index }) => index);
  if (new Set(indexes).size !== indexes.length) {
    throw new RangeError("Visible patch entries must have unique indexes");
  }
  if (indexes.some((index) => index < 0 || index >= sectionPatches.length)) {
    throw new RangeError("Visible patch entry index is outside sectionPatches");
  }
  return [...indexes]
    .sort((left, right) => left - right)
    .map((index) => sectionPatches[index])
    .join("");
}

/**
 * @param {number} totalSections
 * @param {Set<number>} reviewedIndexes
 * @returns {{ reviewed: number, total: number }}
 */
export function patchReviewProgress(totalSections, reviewedIndexes) {
  if (!Number.isInteger(totalSections) || totalSections < 0) {
    throw new RangeError("totalSections must be a non-negative integer");
  }
  if (!(reviewedIndexes instanceof Set)) {
    throw new TypeError("reviewedIndexes must be a Set");
  }
  for (const index of reviewedIndexes) {
    if (!Number.isInteger(index) || index < 0 || index >= totalSections) {
      throw new RangeError("reviewed index is outside the patch sections");
    }
  }
  return { reviewed: reviewedIndexes.size, total: totalSections };
}

/** @param {PatchReviewEntry[]} entries */
function assertEntries(entries) {
  if (!Array.isArray(entries)) throw new TypeError("entries must be an array");
  const indexes = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || !Number.isInteger(entry.index) || entry.index < 0 || !entry.section || typeof entry.section.title !== "string") {
      throw new TypeError("entries must contain indexed patch sections");
    }
    if (indexes.has(entry.index)) throw new RangeError("entries must have unique indexes");
    indexes.add(entry.index);
  }
}

/** @param {string[]} choices @param {string} value @param {string} label */
function assertChoice(choices, value, label) {
  if (!choices.includes(value)) throw new RangeError(`Unknown ${label}: ${value}`);
}

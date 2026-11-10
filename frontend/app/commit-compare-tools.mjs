// @ts-check

import { buildInvestigationShareUrl } from "./investigation-presets-tools.mjs";

/**
 * Pure helpers for the explicit commit comparison form and its downloads.
 * The backend owns ref resolution and diff facts; these helpers only format
 * the user-provided request and the already-authoritative response.
 */

export const COMPARISON_MODES = ["direct", "merge-base"];

/** @param {string} path @param {string} base @param {string} target @param {string} mode */
export function buildComparisonQuery(path, base, target, mode) {
  if (typeof path !== "string" || path.length === 0) throw new RangeError("Comparison path is required");
  if (typeof base !== "string" || base.trim().length === 0) throw new RangeError("Comparison base is required");
  if (typeof target !== "string" || target.trim().length === 0) throw new RangeError("Comparison target is required");
  if (!COMPARISON_MODES.includes(mode)) throw new RangeError(`Unknown comparison mode: ${mode}`);
  return new URLSearchParams({ path, base, target, mode }).toString();
}

/** @param {{base: string, target: string}} values */
export function swapComparisonValues(values) {
  if (!values || typeof values.base !== "string" || typeof values.target !== "string") {
    throw new TypeError("Comparison values must include base and target strings");
  }
  return { ...values, base: values.target, target: values.base };
}

/**
 * Prefix values that spreadsheet applications may interpret as formulas.
 * This mirrors the commit inventory export and keeps paths safe in CSV files.
 * @param {unknown} value
 */
export function escapeComparisonSpreadsheetFormula(value) {
  const text = String(value);
  // Spreadsheet applications may ignore leading spaces, tabs, newlines, or
  // a BOM before interpreting a cell as a formula. Protect the first
  // significant character as well as a directly leading operator.
  return /^[\s\uFEFF]*[=+\-@]/.test(text) ? `'${text}` : text;
}

/** @param {unknown} value */
function csvCell(value) {
  const text = escapeComparisonSpreadsheetFormula(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** @param {{path: string, old_path?: string, additions: number|string, deletions: number|string, binary: boolean}[]} files */
export function buildComparisonFilesCsv(files) {
  const rows = [
    ["path", "oldpath", "additions", "deletions", "binary"],
    ...files.map((file) => [
      file.path,
      file.old_path === undefined ? "" : file.old_path,
      file.binary || file.additions === "-" ? "unknown" : String(file.additions),
      file.binary || file.deletions === "-" ? "unknown" : String(file.deletions),
      file.binary ? "true" : "false",
    ]),
  ];
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/** @param {{base: string, target: string, patch_truncated: boolean}} comparison */
export function comparisonPatchDownloadName(comparison) {
  const base = comparison.base.slice(0, 12);
  const target = comparison.target.slice(0, 12);
  return `${base}-${target}${comparison.patch_truncated ? "-partial" : ""}.patch`;
}

/** @param {boolean} truncated */
export function comparisonPatchDownloadStatus(truncated) {
  return truncated
    ? "差分は上限で切り詰められています。部分的なパッチの保存を開始しました。"
    : "完全なパッチの保存を開始しました。";
}

/** @param {string} value */
function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Add the concrete host repository to the backend's immutable-hash command.
 * The backend command remains the source of the Git flags and hashes; this
 * helper only makes the copied command runnable from an arbitrary directory.
 * @param {string} path
 * @param {string} command
 */
export function comparisonReproductionCommand(path, command) {
  if (typeof path !== "string" || path.length === 0) throw new RangeError("Comparison path is required");
  if (typeof command !== "string" || !command.startsWith("git ") || /[\x00\r\n]/.test(command)) {
    throw new RangeError("Comparison command is invalid");
  }
  return `git -C ${shellQuote(path)} ${command.slice(4)}`;
}

/** @param {string} mode */
export function comparisonModeLabel(mode) {
  if (mode === "direct") return "直接比較";
  if (mode === "merge-base") return "共通祖先（merge-base）から比較";
  throw new RangeError(`Unknown comparison mode: ${mode}`);
}

/** @param {string} origin @param {string} path @param {{base: string, target: string, mode: string}} result */
export function pinnedComparisonUrl(origin, path, result) {
  const url = new URL("/project", origin);
  url.search = new URLSearchParams({ path, tab: "info" }).toString();
  return buildInvestigationShareUrl(url.href, "compare", {
    base: result.base, target: result.target, mode: result.mode,
  });
}

export const COMPARISON_STAT_LABELS = /** @type {const} */ ({
  files: "ファイル", additions: "追加行（既知）", deletions: "削除行（既知）", binary: "バイナリ", renamed: "名前変更",
});

/** @typedef {Record<keyof typeof COMPARISON_STAT_LABELS, number|null>} ComparisonStats */

/** @param {ComparisonStats} previous @param {ComparisonStats} current */
export function comparisonStatChanges(previous, current) {
  const keys = /** @type {(keyof ComparisonStats)[]} */ (Object.keys(COMPARISON_STAT_LABELS));
  return keys.map((key) => {
    const before = previous[key];
    const after = current[key];
    return { label: COMPARISON_STAT_LABELS[key], before, after, delta: before === null || after === null ? null : after - before };
  });
}

/** @param {string} path @param {{base: string, target: string, comparison_base: string, merge_base: string|null, mode: string, patch_truncated: boolean, stats: ComparisonStats, command: string}} result */
export function buildComparisonMarkdown(path, result) {
  const context = {
    path,
    mode: result.mode,
    base: result.base,
    target: result.target,
    comparison_base: result.comparison_base,
    merge_base: result.merge_base,
    patch_truncated: result.patch_truncated,
    ...result.stats,
    command: comparisonReproductionCommand(path, result.command),
  };
  return `## コミット比較\n\n\`\`\`json\n${JSON.stringify(context, null, 2).replaceAll("\`", "\\u0060")}\n\`\`\`\n`;
}

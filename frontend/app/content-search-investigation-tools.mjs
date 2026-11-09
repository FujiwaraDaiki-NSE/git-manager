function requiredString(value, name) {
  if (typeof value !== "string") throw new TypeError(`${name} must be provided explicitly`);
  return value;
}

function requiredMatches(matches) {
  if (!Array.isArray(matches)) throw new TypeError("matches must be an array");
  for (const match of matches) {
    if (!match || typeof match.path !== "string" || match.path === "" || !Number.isSafeInteger(match.line) || match.line < 1 || typeof match.text !== "string") {
      throw new TypeError("each match must have an explicit path, positive line, and text");
    }
  }
  return matches;
}

function requiredReviewKeys(keys) {
  if (!(keys instanceof Set) || [...keys].some((key) => typeof key !== "string")) throw new TypeError("reviewedKeys must be a string Set");
  return keys;
}

/** Empty bounds mean no bound. Invalid user input never becomes an unrestricted range. */
export function contentSearchLineRange(from, to) {
  requiredString(from, "from");
  requiredString(to, "to");
  const parse = (value) => value === "" ? null : /^[1-9]\d*$/u.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : NaN;
  const minimum = parse(from);
  const maximum = parse(to);
  if (Number.isNaN(minimum) || Number.isNaN(maximum)) return { valid: false, minimum: null, maximum: null, error: "行番号は1以上の整数で指定してください。空欄は制限なしです。" };
  if (minimum !== null && maximum !== null && minimum > maximum) return { valid: false, minimum, maximum, error: "開始行は終了行以下にしてください。" };
  return { valid: true, minimum, maximum, error: null };
}

/** Plain dotfiles and trailing dots are extensionless; suffixes are case-insensitive. */
export function contentSearchExtension(path) {
  requiredString(path, "path");
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 || dot === name.length - 1 ? "" : name.slice(dot).toLocaleLowerCase();
}

export function contentSearchExtensions(matches) {
  requiredMatches(matches);
  return [...new Set(matches.map((match) => contentSearchExtension(match.path)))].sort((left, right) => left.localeCompare(right, "ja"));
}

/** Review identity belongs to one fetched response; callers reset the Set on a new request. */
export function contentSearchReviewKey(match) {
  requiredMatches([match]);
  return JSON.stringify([match.path, match.line, match.text]);
}

/** Apply extra local conditions to the rows already selected and ordered by the search panel. */
export function filterContentSearchInvestigationMatches(matches, options) {
  requiredMatches(matches);
  if (!options || typeof options !== "object") throw new TypeError("options must be provided explicitly");
  const { extension, lineFrom, lineTo, excludedQuery, hideReviewed, reviewedKeys } = options;
  if (extension !== null && typeof extension !== "string") throw new TypeError("extension must be a string or null");
  requiredString(excludedQuery, "excludedQuery");
  if (typeof hideReviewed !== "boolean") throw new TypeError("hideReviewed must be provided explicitly");
  requiredReviewKeys(reviewedKeys);
  const range = contentSearchLineRange(lineFrom, lineTo);
  if (!range.valid) return [];
  const excluded = excludedQuery.trim().toLocaleLowerCase();
  return matches.filter((match) => {
    if (extension !== null && contentSearchExtension(match.path) !== extension) return false;
    if (range.minimum !== null && match.line < range.minimum) return false;
    if (range.maximum !== null && match.line > range.maximum) return false;
    if (excluded !== "" && (match.path.toLocaleLowerCase().includes(excluded) || match.text.toLocaleLowerCase().includes(excluded))) return false;
    return !hideReviewed || !reviewedKeys.has(contentSearchReviewKey(match));
  });
}

/** Summarize only the current visible rows; order files by their first visible match. */
export function contentSearchFileSummaries(matches, reviewedKeys) {
  requiredMatches(matches);
  requiredReviewKeys(reviewedKeys);
  const files = new Map();
  for (const match of matches) {
    let file = files.get(match.path);
    if (file === undefined) {
      file = { path: match.path, count: 0, firstLine: match.line, lastLine: match.line, reviewed: 0, percent: 0 };
      files.set(match.path, file);
    }
    file.count += 1;
    file.firstLine = Math.min(file.firstLine, match.line);
    file.lastLine = Math.max(file.lastLine, match.line);
    if (reviewedKeys.has(contentSearchReviewKey(match))) file.reviewed += 1;
  }
  return [...files.values()].map((file) => ({ ...file, percent: file.count / matches.length * 100 }));
}

/** Copy the displayed source lines, preserving tabs/CR and omitting UI line numbers. */
export function contentSearchRawContext(context) {
  if (!context || typeof context !== "object" || !Array.isArray(context.lines) || context.lines.length === 0) throw new TypeError("context must contain displayed lines");
  if (context.lines.some((line) => !line || typeof line.text !== "string")) throw new TypeError("context lines must contain explicit text");
  return context.lines.map((line) => line.text).join("\n");
}

/** Retain added local investigation conditions in the existing Markdown handoff. */
export function contentSearchExtraConditionsMarkdown(conditions) {
  if (!conditions || typeof conditions !== "object") throw new TypeError("conditions must be provided explicitly");
  const { extension, line_from, line_to, exclude, hide_reviewed, reviewed_matches } = conditions;
  if (extension !== null && typeof extension !== "string") throw new TypeError("extension must be a string or null");
  requiredString(exclude, "exclude");
  const range = contentSearchLineRange(line_from, line_to);
  if (!range.valid) throw new TypeError("line range must be valid");
  if (typeof hide_reviewed !== "boolean" || !Number.isSafeInteger(reviewed_matches) || reviewed_matches < 0) throw new TypeError("review conditions must be explicit");
  return `\n## 追加のローカル条件\n\n- 拡張子: ${JSON.stringify(extension)}（nullはすべて、空文字は拡張子なし）\n- 行範囲: ${range.minimum === null ? "制限なし" : range.minimum}–${range.maximum === null ? "制限なし" : range.maximum}\n- 除外語（path / 内容、大小文字を区別しない）: ${JSON.stringify(exclude)}\n- 確認済みを非表示: ${hide_reviewed}\n- 取得済み一致行の確認済み数: ${reviewed_matches}\n`;
}

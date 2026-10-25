function requiredString(value, name) {
  if (typeof value !== "string") throw new TypeError(`${name} must be provided explicitly`);
  return value;
}

function requiredBoolean(value, name) {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be provided explicitly`);
  return value;
}

export const CONTENT_SEARCH_SORTS = Object.freeze([
  { key: "git", label: "Git順" },
  { key: "path", label: "パス順" },
  { key: "line", label: "行番号順" },
  { key: "text", label: "内容順" },
]);

const CONTENT_SEARCH_SORT_VALUES = new Set(CONTENT_SEARCH_SORTS.map(({ key }) => key));

function requiredMatches(matches) {
  if (!Array.isArray(matches)) throw new TypeError("matches must be an array");
  for (const match of matches) {
    if (!match || typeof match !== "object") throw new TypeError("each match must be an object");
    if (typeof match.path !== "string" || match.path.length === 0) throw new TypeError("each match must have a non-empty path");
    if (!Number.isSafeInteger(match.line) || match.line < 1) throw new TypeError("each match must have a positive line");
    if (typeof match.text !== "string") throw new TypeError("each match must have string text");
  }
  return matches;
}

function requiredSort(sort) {
  if (typeof sort !== "string" || !CONTENT_SEARCH_SORT_VALUES.has(sort)) throw new TypeError("sort must be a known content-search order");
  return sort;
}

function contentSearchSortLabel(sort) {
  requiredSort(sort);
  return CONTENT_SEARCH_SORTS.find((option) => option.key === sort).label;
}

function compareText(left, right) {
  return String(left).localeCompare(String(right), "ja", { sensitivity: "base" });
}

/** Filter only the rows already returned by the server.  Search is a literal, case-insensitive path/text substring. */
export function filterContentSearchMatches(matches, localQuery, pathFilter) {
  requiredMatches(matches);
  requiredString(localQuery, "localQuery");
  requiredString(pathFilter, "pathFilter");
  const needle = localQuery.trim().toLocaleLowerCase();
  return matches.filter((match) => {
    if (pathFilter !== "" && match.path !== pathFilter) return false;
    if (needle === "") return true;
    return match.path.toLocaleLowerCase().includes(needle) || match.text.toLocaleLowerCase().includes(needle);
  });
}

/** Sort a copied row list without changing the server's match order.  Ties retain the incoming order. */
export function sortContentSearchMatches(matches, sort) {
  requiredMatches(matches);
  const order = requiredSort(sort);
  return matches.map((match, index) => ({ match, index })).sort((left, right) => {
    let difference = 0;
    if (order === "path") difference = compareText(left.match.path, right.match.path);
    if (order === "line") difference = left.match.line - right.match.line;
    if (order === "text") difference = compareText(left.match.text, right.match.text);
    return difference === 0 ? left.index - right.index : difference;
  }).map(({ match }) => match);
}

/** Apply local search, exact path selection, and the selected order to fetched rows. */
export function contentSearchVisibleMatches(matches, options) {
  requiredMatches(matches);
  if (!options || typeof options !== "object") throw new TypeError("local filter options must be provided explicitly");
  const { localQuery, pathFilter, sort } = options;
  return sortContentSearchMatches(filterContentSearchMatches(matches, localQuery, pathFilter), sort);
}

/** Return distinct paths in their first displayed/server order for the exact path selector. */
export function contentSearchPaths(matches) {
  requiredMatches(matches);
  const seen = new Set();
  const paths = [];
  for (const match of matches) {
    if (seen.has(match.path)) continue;
    seen.add(match.path);
    paths.push(match.path);
  }
  return paths;
}

function sameContentSearchMatch(left, right) {
  return left.path === right.path && left.line === right.line && left.text === right.text;
}

/** Return adjacent rows in the current visible order; there is no wraparound and excluded selections stay explicit. */
export function adjacentContentSearchMatches(matches, selectedMatch) {
  requiredMatches(matches);
  if (selectedMatch !== null && (typeof selectedMatch !== "object" || selectedMatch === undefined)) {
    throw new TypeError("selectedMatch must be a match or null");
  }
  if (selectedMatch !== null) requiredMatches([selectedMatch]);
  const index = selectedMatch === null ? -1 : matches.findIndex((match) => sameContentSearchMatch(match, selectedMatch));
  return {
    index,
    count: matches.length,
    previous: index > 0 ? matches[index - 1] : null,
    next: index >= 0 && index + 1 < matches.length ? matches[index + 1] : null,
  };
}

/** Serialize the visible rows as a path-keyed JSON object whose values are the displayed line list. */
export function contentSearchPathLineList(matches) {
  requiredMatches(matches);
  const grouped = new Map();
  for (const match of matches) {
    const lines = grouped.get(match.path);
    if (lines === undefined) grouped.set(match.path, [match.line]);
    else lines.push(match.line);
  }
  return `${JSON.stringify(Object.fromEntries(grouped), null, 2)}\n`;
}

function requiredSearchExportMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") throw new TypeError("content-search export metadata must be provided explicitly");
  const { repository_path, pinned_hash, input, coverage, local_conditions } = metadata;
  requiredString(repository_path, "repository_path");
  requiredString(pinned_hash, "pinned_hash");
  if (!input || typeof input !== "object") throw new TypeError("input must be provided explicitly");
  const { revision, query, case_sensitive, directory } = input;
  requiredString(revision, "input.revision");
  requiredString(query, "input.query");
  requiredBoolean(case_sensitive, "input.case_sensitive");
  requiredString(directory, "input.directory");
  if (!coverage || typeof coverage !== "object") throw new TypeError("coverage must be provided explicitly");
  const { server_matches, visible_matches, server_truncated, server_limit, server_byte_limit } = coverage;
  for (const [value, name] of [[server_matches, "coverage.server_matches"], [visible_matches, "coverage.visible_matches"], [server_limit, "coverage.server_limit"], [server_byte_limit, "coverage.server_byte_limit"]]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`);
  }
  requiredBoolean(server_truncated, "coverage.server_truncated");
  if (!local_conditions || typeof local_conditions !== "object") throw new TypeError("local_conditions must be provided explicitly");
  const { search, path, sort } = local_conditions;
  requiredString(search, "local_conditions.search");
  requiredString(path, "local_conditions.path");
  requiredSort(sort);
  return metadata;
}

/** Serialize exactly the displayed rows with immutable server inputs and local display conditions. */
export function contentSearchJson(matches, metadata) {
  requiredMatches(matches);
  const validated = requiredSearchExportMetadata(metadata);
  return `${JSON.stringify({
    repository_path: validated.repository_path,
    pinned_hash: validated.pinned_hash,
    input: validated.input,
    coverage: validated.coverage,
    local_conditions: validated.local_conditions,
    matches,
  }, null, 2)}\n`;
}

function markdownValue(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("|", "\\|")
    .replace(/\r\n|\r|\n/g, "<br>");
}

function markdownBoolean(value) {
  return value ? "true" : "false";
}

function requiredContext(context) {
  if (context === null) return null;
  if (!context || typeof context !== "object") throw new TypeError("context must be a context object or null");
  const { start, end, lines } = context;
  if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(end) || end < start || !Array.isArray(lines)) throw new TypeError("context range is invalid");
  for (const line of lines) {
    if (!line || typeof line !== "object" || !Number.isSafeInteger(line.line) || line.line < 1 || typeof line.text !== "string" || typeof line.highlight !== "boolean") throw new TypeError("context lines are invalid");
  }
  return context;
}

/** Build a Markdown handoff for one selected match, including the fetched preview state explicitly. */
export function contentSearchInvestigationMarkdown(match, metadata, context, preview) {
  requiredMatches([match]);
  const validated = requiredSearchExportMetadata(metadata);
  const validatedContext = requiredContext(context);
  if (!preview || typeof preview !== "object") throw new TypeError("preview metadata must be provided explicitly");
  const { binary, text_available, truncated } = preview;
  requiredBoolean(binary, "preview.binary");
  requiredBoolean(text_available, "preview.text_available");
  requiredBoolean(truncated, "preview.truncated");
  const lines = [
    "# 内容検索の調査レポート",
    "",
    "## 検索条件",
    "",
    `- リポジトリ: ${markdownValue(validated.repository_path)}`,
    `- 固定ハッシュ: ${markdownValue(validated.pinned_hash)}`,
    `- サーバー検索リビジョン: ${markdownValue(validated.input.revision)}`,
    `- サーバー検索語: ${markdownValue(validated.input.query)}`,
    `- 大文字・小文字を区別: ${markdownBoolean(validated.input.case_sensitive)}`,
    `- サーバー検索ディレクトリ: ${validated.input.directory === "" ? "ルート全体" : markdownValue(validated.input.directory)}`,
    `- サーバー取得行数: ${validated.coverage.server_matches}`,
    `- サーバー結果の切詰め: ${markdownBoolean(validated.coverage.server_truncated)}`,
    `- 表示中の行数: ${validated.coverage.visible_matches}`,
    `- ローカル検索: ${validated.local_conditions.search === "" ? "なし" : markdownValue(validated.local_conditions.search)}`,
    `- path 完全一致: ${validated.local_conditions.path === "" ? "すべて" : markdownValue(validated.local_conditions.path)}`,
    `- 表示順: ${contentSearchSortLabel(validated.local_conditions.sort)} (${markdownValue(validated.local_conditions.sort)})`,
    "- path別行番号JSON: pathをキー、表示中の行番号配列を値とするオブジェクト",
    "",
    "## 選択した一致行",
    "",
    `- path: ${markdownValue(match.path)}`,
    `- 行: ${match.line}`,
    `- 内容: ${markdownValue(match.text)}`,
    "",
    "## 取得済みコンテキスト",
    "",
    `- 本文取得可能: ${markdownBoolean(text_available)}`,
    `- バイナリ: ${markdownBoolean(binary)}`,
    `- 取得済み本文の切詰め: ${markdownBoolean(truncated)}`,
  ];
  if (validatedContext === null) {
    lines.push("- コンテキスト: 取得済み本文がないため表示なし");
  } else {
    lines.push(`- 取得範囲: 行 ${validatedContext.start}–${validatedContext.end}`);
    lines.push("", "```text");
    for (const line of validatedContext.lines) lines.push(`    ${line.line}${line.highlight ? " *" : "  "} | ${line.text.replace(/\r/g, "")}`);
    lines.push("```");
  }
  return `${lines.join("\n")}\n`;
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

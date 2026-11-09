"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import CopyButton from "./copy-button";
import {
  CONTENT_SEARCH_SORTS,
  adjacentContentSearchMatches,
  buildContentSearchFileHistoryHref,
  contentSearchContext,
  contentSearchCsv,
  contentSearchFileQuery,
  contentSearchInvestigationMarkdown,
  contentSearchJson,
  contentSearchMatchKey,
  contentSearchPathLineList,
  contentSearchPaths,
  contentSearchQuery,
  contentSearchRequestKey,
  contentSearchVisibleMatches,
} from "./content-search-tools.mjs";
import {
  contentSearchExtensions,
  contentSearchExtraConditionsMarkdown,
  contentSearchFileSummaries,
  contentSearchLineRange,
  contentSearchRawContext,
  contentSearchReviewKey,
  filterContentSearchInvestigationMatches,
} from "./content-search-investigation-tools.mjs";
import "./content-search.css";
import "./content-search-investigation-tools.css";

type ContentSearchMatch = {
  path: string;
  line: number;
  text: string;
};

type ContentSearchResponse = {
  revision: string;
  pinned_hash: string;
  query: string;
  case_sensitive: boolean;
  directory: string;
  matches: ContentSearchMatch[];
  truncated: boolean;
  limit: number;
  byte_limit: number;
};

type RepositoryFilePayload = {
  revision: string;
  pinned_hash: string;
  path: string;
  binary: boolean;
  text: string | null;
  truncated: boolean;
  downloadable: boolean;
  size: number;
  download_limit: number;
};

type LoadState = "idle" | "loading" | "ready" | "error";
type ContentSearchSort = "git" | "path" | "line" | "text";

type ContentSearchContext = {
  start: number;
  end: number;
  lines: { line: number; text: string; highlight: boolean }[];
};

type ContentSearchExportMetadata = {
  repository_path: string;
  pinned_hash: string;
  input: {
    revision: string;
    query: string;
    case_sensitive: boolean;
    directory: string;
  };
  coverage: {
    server_matches: number;
    visible_matches: number;
    server_truncated: boolean;
    server_limit: number;
    server_byte_limit: number;
  };
  local_conditions: {
    search: string;
    path: string;
    sort: ContentSearchSort;
    extension: string | null;
    line_from: string;
    line_to: string;
    exclude: string;
    hide_reviewed: boolean;
    reviewed_matches: number;
  };
};

const CONTENT_SEARCH_SORT_LABELS: Record<ContentSearchSort, string> = {
  git: "Git順",
  path: "パス順",
  line: "行番号順",
  text: "内容順",
};

const CONTEXT_RADII = [0, 1, 3, 5, 10, 20];

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isMatch(value: unknown): value is ContentSearchMatch {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ContentSearchMatch>;
  return isString(item.path) && item.path.length > 0
    && Number.isInteger(item.line) && (item.line as number) > 0
    && isString(item.text);
}

function isSearchResponse(value: unknown): value is ContentSearchResponse {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ContentSearchResponse>;
  return isString(item.revision)
    && isString(item.pinned_hash)
    && isString(item.query)
    && typeof item.case_sensitive === "boolean"
    && isString(item.directory)
    && Array.isArray(item.matches)
    && item.matches.every(isMatch)
    && typeof item.truncated === "boolean"
    && Number.isInteger(item.limit)
    && Number.isInteger(item.byte_limit);
}

function isFilePayload(value: unknown): value is RepositoryFilePayload {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<RepositoryFilePayload>;
  return isString(item.revision)
    && isString(item.pinned_hash)
    && isString(item.path)
    && typeof item.binary === "boolean"
    && (item.text === null || isString(item.text))
    && typeof item.truncated === "boolean"
    && typeof item.downloadable === "boolean"
    && Number.isInteger(item.size)
    && Number.isInteger(item.download_limit);
}

async function responseError(response: Response) {
  try {
    const body = await response.json() as { detail?: unknown };
    if (typeof body.detail === "string" && body.detail) return body.detail;
  } catch {
    // The status below remains useful when a proxy returns non-JSON text.
  }
  return `HTTP ${response.status}`;
}

function shortHash(value: string) {
  return value.slice(0, 12);
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value < 0) return "サイズ未取得";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
}

function downloadCsv(matches: ContentSearchMatch[], setStatus: (message: string) => void) {
  try {
    const url = URL.createObjectURL(new Blob([contentSearchCsv(matches)], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "gitdash-content-search.csv";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(`${matches.length}行の表示中CSV保存を開始しました。`);
  } catch {
    setStatus("CSVを保存できませんでした。");
  }
}

function downloadJson(matches: ContentSearchMatch[], metadata: ContentSearchExportMetadata, setStatus: (message: string) => void) {
  try {
    const url = URL.createObjectURL(new Blob([contentSearchJson(matches, metadata)], { type: "application/json;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "gitdash-content-search.json";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(`${matches.length}行の表示中JSON保存を開始しました。`);
  } catch {
    setStatus("JSONを保存できませんでした。調査条件を確認してください。");
  }
}

export default function ContentSearch({ path }: { path: string }) {
  const [revision, setRevision] = useState("");
  const [query, setQuery] = useState("");
  const [directory, setDirectory] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [matches, setMatches] = useState<ContentSearchMatch[]>([]);
  const [localQuery, setLocalQuery] = useState("");
  const [pathFilter, setPathFilter] = useState("");
  const [sort, setSort] = useState<ContentSearchSort>("git");
  const [extensionFilter, setExtensionFilter] = useState<string | null>(null);
  const [lineFrom, setLineFrom] = useState("");
  const [lineTo, setLineTo] = useState("");
  const [excludedQuery, setExcludedQuery] = useState("");
  const [reviewedKeys, setReviewedKeys] = useState<Set<string>>(new Set());
  const [hideReviewed, setHideReviewed] = useState(false);
  const [contextRadius, setContextRadius] = useState(3);
  const [pinnedHash, setPinnedHash] = useState<string | null>(null);
  const [result, setResult] = useState<ContentSearchResponse | null>(null);
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState("");
  const [selectedMatch, setSelectedMatch] = useState<ContentSearchMatch | null>(null);
  const [preview, setPreview] = useState<RepositoryFilePayload | null>(null);
  const [previewState, setPreviewState] = useState<LoadState>("idle");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const searchControllerRef = useRef<AbortController | null>(null);
  const previewControllerRef = useRef<AbortController | null>(null);
  const searchKeyRef = useRef<string | null>(null);
  const previewKeyRef = useRef<string | null>(null);
  const [open, setOpen] = useState(false);

  // A repository change starts a new investigation context.  Nothing from a
  // previous repository, including its pinned hash, is retained.
  useEffect(() => {
    searchControllerRef.current?.abort();
    previewControllerRef.current?.abort();
    searchControllerRef.current = null;
    previewControllerRef.current = null;
    searchKeyRef.current = null;
    previewKeyRef.current = null;
    setRevision("");
    setQuery("");
    setDirectory("");
    setCaseSensitive(false);
    setMatches([]);
    setLocalQuery("");
    setPathFilter("");
    setSort("git");
    setExtensionFilter(null);
    setLineFrom("");
    setLineTo("");
    setExcludedQuery("");
    setReviewedKeys(new Set());
    setHideReviewed(false);
    setContextRadius(3);
    setPinnedHash(null);
    setResult(null);
    setState("idle");
    setError(null);
    setExportStatus("");
    setSelectedMatch(null);
    setPreview(null);
    setPreviewState("idle");
    setPreviewError(null);
    setOpen(false);
  }, [path]);

  // Editing any server-side condition invalidates rows from the old pinned
  // snapshot.  A new request is always an explicit button action.
  useEffect(() => {
    searchControllerRef.current?.abort();
    previewControllerRef.current?.abort();
    searchControllerRef.current = null;
    previewControllerRef.current = null;
    searchKeyRef.current = null;
    previewKeyRef.current = null;
    setMatches([]);
    setLocalQuery("");
    setPathFilter("");
    setSort("git");
    setExtensionFilter(null);
    setLineFrom("");
    setLineTo("");
    setExcludedQuery("");
    setReviewedKeys(new Set());
    setHideReviewed(false);
    setPinnedHash(null);
    setResult(null);
    setState("idle");
    setError(null);
    setExportStatus("");
    setSelectedMatch(null);
    setPreview(null);
    setPreviewState("idle");
    setPreviewError(null);
  }, [caseSensitive, directory, query, revision]);

  const activeKey = useMemo(
    () => contentSearchRequestKey(path, revision, query, caseSensitive, directory),
    [caseSensitive, directory, path, query, revision],
  );

  const load = () => {
    if (!path || !revision || !query) {
      setError("リポジトリ、リビジョン、検索語を指定してください。");
      setState("error");
      return;
    }
    if (activeKey === null) {
      setError("検索条件を確認してください。");
      setState("error");
      return;
    }
    searchControllerRef.current?.abort();
    previewControllerRef.current?.abort();
    const controller = new AbortController();
    searchControllerRef.current = controller;
    searchKeyRef.current = activeKey;
    setState("loading");
    setError(null);
    setExportStatus("");
    setMatches([]);
    setReviewedKeys(new Set());
    setHideReviewed(false);
    setPinnedHash(null);
    setResult(null);
    setSelectedMatch(null);
    setPreview(null);
    setPreviewState("idle");
    setPreviewError(null);
    setOpen(true);
    const params = contentSearchQuery(path, revision, query, caseSensitive, directory);
    void fetch(`/api/repo/content-search?${params}`, { cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(await responseError(response));
      const value: unknown = await response.json();
      if (!isSearchResponse(value)) throw new Error("内容検索の応答形式が不正です。");
      return value;
    }).then((value) => {
      if (controller.signal.aborted || searchKeyRef.current !== activeKey) return;
      setMatches(value.matches);
      setPinnedHash(value.pinned_hash);
      setResult(value);
      setState("ready");
    }).catch((caught: unknown) => {
      if (controller.signal.aborted || searchKeyRef.current !== activeKey) return;
      setError(caught instanceof Error ? caught.message : "内容検索を取得できませんでした。");
      setState("error");
    }).finally(() => {
      if (searchControllerRef.current === controller && searchKeyRef.current === activeKey) searchControllerRef.current = null;
    });
  };

  const selectMatch = (match: ContentSearchMatch) => {
    if (!pinnedHash) return;
    previewControllerRef.current?.abort();
    const controller = new AbortController();
    const key = JSON.stringify([path, pinnedHash, match.path, match.line]);
    previewControllerRef.current = controller;
    previewKeyRef.current = key;
    setSelectedMatch(match);
    setPreviewState("loading");
    setPreviewError(null);
    setPreview(null);
    const params = contentSearchFileQuery(path, pinnedHash, match.path);
    void fetch(`/api/repo/file?${params}`, { cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(await responseError(response));
      const value: unknown = await response.json();
      if (!isFilePayload(value)) throw new Error("一致行のファイル応答形式が不正です。");
      if (value.pinned_hash !== pinnedHash) throw new Error("検索結果と異なる版のファイルが返されました。");
      return value;
    }).then((value) => {
      if (controller.signal.aborted || previewKeyRef.current !== key) return;
      setPreview(value);
      setPreviewState("ready");
    }).catch((caught: unknown) => {
      if (controller.signal.aborted || previewKeyRef.current !== key) return;
      setPreviewError(caught instanceof Error ? caught.message : "一致行のファイルを取得できませんでした。");
      setPreviewState("error");
    }).finally(() => {
      if (previewControllerRef.current === controller && previewKeyRef.current === key) previewControllerRef.current = null;
    });
  };

  const paths = useMemo(() => contentSearchPaths(matches) as string[], [matches]);
  const extensions = useMemo(() => contentSearchExtensions(matches) as string[], [matches]);
  const lineRange = useMemo(() => contentSearchLineRange(lineFrom, lineTo) as { valid: boolean; error: string | null }, [lineFrom, lineTo]);
  const orderedMatches = useMemo(() => contentSearchVisibleMatches(matches, {
    localQuery,
    pathFilter,
    sort,
  }) as ContentSearchMatch[], [localQuery, matches, pathFilter, sort]);
  const visibleMatches = useMemo(() => filterContentSearchInvestigationMatches(orderedMatches, {
    extension: extensionFilter,
    lineFrom,
    lineTo,
    excludedQuery,
    reviewedKeys,
    hideReviewed,
  }) as ContentSearchMatch[], [excludedQuery, extensionFilter, hideReviewed, lineFrom, lineTo, orderedMatches, reviewedKeys]);
  const reviewedCount = useMemo(() => matches.filter((match) => reviewedKeys.has(contentSearchReviewKey(match))).length, [matches, reviewedKeys]);
  const fileSummaries = useMemo(() => contentSearchFileSummaries(visibleMatches, reviewedKeys) as {
    path: string;
    count: number;
    firstLine: number;
    lastLine: number;
    reviewed: number;
    percent: number;
  }[], [reviewedKeys, visibleMatches]);
  const navigation = useMemo(() => adjacentContentSearchMatches(visibleMatches, selectedMatch) as {
    index: number;
    count: number;
    previous: ContentSearchMatch | null;
    next: ContentSearchMatch | null;
  }, [selectedMatch, visibleMatches]);
  const exportMetadata = useMemo<ContentSearchExportMetadata | null>(() => {
    if (!result || !pinnedHash || !lineRange.valid) return null;
    return {
      repository_path: path,
      pinned_hash: pinnedHash,
      input: {
        revision: result.revision,
        query: result.query,
        case_sensitive: result.case_sensitive,
        directory: result.directory,
      },
      coverage: {
        server_matches: matches.length,
        visible_matches: visibleMatches.length,
        server_truncated: result.truncated,
        server_limit: result.limit,
        server_byte_limit: result.byte_limit,
      },
      local_conditions: {
        search: localQuery,
        path: pathFilter,
        sort,
        extension: extensionFilter,
        line_from: lineFrom,
        line_to: lineTo,
        exclude: excludedQuery,
        hide_reviewed: hideReviewed,
        reviewed_matches: reviewedCount,
      },
    };
  }, [excludedQuery, extensionFilter, hideReviewed, lineFrom, lineRange.valid, lineTo, localQuery, matches.length, path, pathFilter, pinnedHash, result, reviewedCount, sort, visibleMatches.length]);
  const pathLineList = useMemo(() => contentSearchPathLineList(visibleMatches) as string, [visibleMatches]);
  const context = selectedMatch && preview?.text !== null && preview?.text !== undefined
    ? contentSearchContext(preview.text, selectedMatch.line, contextRadius) as ContentSearchContext
    : null;
  const rawContext = context && context.lines.some((line) => line.highlight) ? contentSearchRawContext(context) as string : null;
  const investigationReport = exportMetadata && selectedMatch && previewState === "ready" && preview
    ? contentSearchInvestigationMarkdown(selectedMatch, exportMetadata, context && context.start <= context.end ? context : null, {
      binary: preview.binary,
      text_available: preview.text !== null,
      truncated: preview.truncated,
    }) + contentSearchExtraConditionsMarkdown(exportMetadata.local_conditions) as string
    : null;
  const historyHref = useMemo(() => {
    if (typeof window === "undefined" || !pinnedHash || !selectedMatch) return null;
    try {
      return buildContentSearchFileHistoryHref(window.location.href, path, pinnedHash, selectedMatch.path, true);
    } catch {
      return null;
    }
  }, [path, pinnedHash, selectedMatch]);

  const clearLocalFilters = () => {
    setLocalQuery("");
    setPathFilter("");
    setSort("git");
    setExtensionFilter(null);
    setLineFrom("");
    setLineTo("");
    setExcludedQuery("");
    setHideReviewed(false);
    setExportStatus("");
  };
  const toggleReviewed = (match: ContentSearchMatch) => {
    const key = contentSearchReviewKey(match) as string;
    setReviewedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const hasLocalFilters = localQuery.trim() !== "" || pathFilter !== "" || sort !== "git" || extensionFilter !== null || lineFrom !== "" || lineTo !== "" || excludedQuery.trim() !== "" || hideReviewed;
  const canRun = Boolean(path && revision && query) && state !== "loading";

  return <details className="content-search" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary id="content-search-title">版を指定して内容を検索 <span>固定revision・ディレクトリ・ローカル絞り込み・CSV/JSON</span></summary>
    <div className="content-search-body">
      <div className="content-search-heading">
        <div>
          <h3>コミット済みの内容を検索</h3>
          <p>リビジョン、検索語、必要ならリポジトリ相対ディレクトリを指定します。検索は固定したGitオブジェクトだけを読み取ります。</p>
        </div>
        <code className="content-search-repo" title={path}>{path}</code>
      </div>

      <div className="content-search-inputs" role="group" aria-label="版の内容検索の対象">
        <label><span>リビジョン（必須）</span><input type="text" value={revision} onChange={(event) => setRevision(event.target.value)} placeholder="HEAD、ブランチ名、完全ハッシュ" aria-label="内容検索のリビジョン" /></label>
        <label><span>検索語（必須・文字列）</span><input type="text" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="検索する文字列" aria-label="内容検索の検索語" /></label>
        <label><span>ディレクトリ（空欄は全体）</span><input type="text" value={directory} onChange={(event) => setDirectory(event.target.value)} placeholder="src/feature" aria-label="内容検索のディレクトリ" /></label>
        <label className="content-search-case"><input type="checkbox" checked={caseSensitive} onChange={(event) => setCaseSensitive(event.target.checked)} aria-label="大文字・小文字を区別" /><span>大文字・小文字を区別</span></label>
        <button type="button" className="primary-action" disabled={!canRun} onClick={load}>{state === "loading" ? "内容を検索中…" : "内容を検索"}</button>
      </div>

      {state === "error" && <p className="content-search-error" role="alert">内容を検索できませんでした。{error && <span>（{error}）</span>}</p>}
      {state === "idle" && <p className="content-search-empty" role="status">リビジョンと検索語を指定して内容を検索してください。</p>}

      {(state === "ready" || (state === "loading" && result) || (state === "error" && result)) && result && <>
        <div className="content-search-coverage" role="status">
          <span>{visibleMatches.length.toLocaleString()} / {matches.length.toLocaleString()} 行を表示</span>
          <span>{caseSensitive ? "大小文字を区別" : "大小文字を区別しない"}</span>
          <span>{directory || "ルート全体"}</span>
          <span>並び順: {CONTENT_SEARCH_SORT_LABELS[sort]}</span>
          {localQuery.trim() !== "" && <span>ローカル検索: {localQuery}</span>}
          {pathFilter !== "" && <span>path: {pathFilter}</span>}
          {extensionFilter !== null && <span>拡張子: {extensionFilter === "" ? "なし" : extensionFilter}</span>}
          {(lineFrom !== "" || lineTo !== "") && <span>行範囲: {lineFrom === "" ? "制限なし" : lineFrom}–{lineTo === "" ? "制限なし" : lineTo}</span>}
          {excludedQuery.trim() !== "" && <span>除外語: {excludedQuery}</span>}
          {hideReviewed && <span>確認済みを非表示</span>}
          <span className="content-search-pinned"><code title={pinnedHash ?? undefined}>{pinnedHash ? shortHash(pinnedHash) : "固定版未取得"}</code></span>
          {exportStatus && <span>{exportStatus}</span>}
        </div>
        {result.truncated && <p className="content-search-truncated" role="status">結果は上限 {result.limit.toLocaleString()} 行または {formatBytes(result.byte_limit)} に達したため一部だけを表示しています。</p>}
        <div className="content-search-tools" role="group" aria-label="内容検索結果の操作">
          <label className="content-search-local-search"><span>取得済み一致行を検索（path / 内容）</span><input type="search" value={localQuery} onChange={(event) => setLocalQuery(event.target.value)} placeholder="pathまたは内容" aria-label="取得済み一致行をpathまたは内容で検索" /></label>
          <label><span>path（完全一致）</span><select value={pathFilter} onChange={(event) => setPathFilter(event.target.value)} aria-label="取得済み一致行をpathで完全一致絞り込み"><option value="">すべて</option>{paths.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          <label><span>表示順</span><select value={sort} onChange={(event) => setSort(event.target.value as ContentSearchSort)} aria-label="内容検索結果の表示順">{CONTENT_SEARCH_SORTS.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label>
          <label><span>拡張子（大小文字を区別しない）</span><select value={extensionFilter === null ? "*" : extensionFilter} onChange={(event) => setExtensionFilter(event.target.value === "*" ? null : event.target.value)} aria-label="取得済み一致行の拡張子"><option value="*">すべて</option>{extensions.map((value) => <option key={value} value={value}>{value === "" ? "拡張子なし" : value}</option>)}</select></label>
          <label className="content-search-line-bound"><span>開始行（含む・空欄は制限なし）</span><input type="text" inputMode="numeric" value={lineFrom} onChange={(event) => setLineFrom(event.target.value)} aria-label="取得済み一致行の開始行" aria-invalid={!lineRange.valid} aria-describedby={!lineRange.valid ? "content-search-range-error" : undefined} /></label>
          <label className="content-search-line-bound"><span>終了行（含む・空欄は制限なし）</span><input type="text" inputMode="numeric" value={lineTo} onChange={(event) => setLineTo(event.target.value)} aria-label="取得済み一致行の終了行" aria-invalid={!lineRange.valid} aria-describedby={!lineRange.valid ? "content-search-range-error" : undefined} /></label>
          <label className="content-search-local-search"><span>除外語（path / 内容、大小文字を区別しない）</span><input type="search" value={excludedQuery} onChange={(event) => setExcludedQuery(event.target.value)} placeholder="不要な一致行を除外" aria-label="取得済み一致行から除外する語" /></label>
          <div className="content-search-filter-actions">
            <button type="button" className="subtle-button" disabled={!hasLocalFilters} onClick={clearLocalFilters}>ローカル条件をリセット</button>
            <button type="button" className="subtle-button" disabled={visibleMatches.length === 0} onClick={() => downloadCsv(visibleMatches, setExportStatus)} aria-label="表示中の内容検索結果をCSV保存">表示中をCSV保存</button>
            <button type="button" className="subtle-button" disabled={visibleMatches.length === 0 || exportMetadata === null} onClick={() => { if (exportMetadata) downloadJson(visibleMatches, exportMetadata, setExportStatus); }} aria-label="表示中の内容検索結果をJSON保存">表示中をJSON保存</button>
            {visibleMatches.length > 0 && <CopyButton value={pathLineList} label="表示中のpath別行番号JSONをコピー" />}
          </div>
        </div>
        {!lineRange.valid && <p id="content-search-range-error" className="content-search-error" role="alert">{lineRange.error}</p>}
        <div className="content-search-review-tools" role="group" aria-label="内容検索のローカル確認状況">
          <span role="status">確認済み {reviewedCount.toLocaleString()} / {matches.length.toLocaleString()} 行（今回の取得結果のみ）</span>
          <label><input type="checkbox" checked={hideReviewed} onChange={(event) => setHideReviewed(event.target.checked)} aria-label="内容検索の確認済み一致行を非表示" />確認済みを非表示</label>
          <button type="button" className="subtle-button" disabled={reviewedCount === 0} onClick={() => setReviewedKeys(new Set())}>確認状況をリセット</button>
        </div>
        {fileSummaries.length > 0 && <details className="content-search-file-summary" open>
          <summary>表示中のファイル別一致数 · {fileSummaries.length.toLocaleString()} ファイル</summary>
          <div className="content-search-file-summary-heading"><span>割合・行範囲は現在表示中の一致行に対する値です。</span>{pathFilter !== "" && <button type="button" className="subtle-button" onClick={() => setPathFilter("")}>ファイル絞り込みを解除</button>}</div>
          <div className="content-search-file-summary-scroll" role="region" aria-label="表示中のファイル別一致数" tabIndex={0}><table><thead><tr><th>ファイル</th><th>一致行数・割合</th><th>行範囲</th><th>確認済み</th><th>操作</th></tr></thead><tbody>{fileSummaries.map((file) => <tr key={file.path}>
            <td><code>{file.path}</code></td><td>{file.count.toLocaleString()} 行 · {file.percent.toFixed(1)}%</td><td>{file.firstLine}–{file.lastLine}</td><td>{file.reviewed} / {file.count}</td><td><button type="button" className="table-action" disabled={pathFilter === file.path} onClick={() => setPathFilter(file.path)} aria-label={`${file.path} の一致行に絞る`}>このファイルに絞る</button></td>
          </tr>)}</tbody></table></div>
        </details>}
        {selectedMatch && navigation.index < 0 && <p className="content-search-selection-note" role="status">選択中の一致行は現在のローカル条件外です。前後の表示結果へ移動できません。</p>}
        {matches.length === 0 ? <p className="content-search-empty" role="status">一致する行はありません。</p> : visibleMatches.length === 0 ? <p className="content-search-empty" role="status">ローカル条件に一致する行はありません。</p> : <div className="content-search-table-wrap" role="region" aria-label="内容検索の一致行" tabIndex={0}><table className="content-search-table"><thead><tr><th>ファイル</th><th>行</th><th>内容</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{visibleMatches.map((match, index) => {
          const selected = selectedMatch?.path === match.path && selectedMatch.line === match.line && selectedMatch.text === match.text;
          const reviewed = reviewedKeys.has(contentSearchReviewKey(match));
          const key = contentSearchMatchKey(match, index) as string;
          return <tr key={key} className={selected ? "is-selected" : undefined} aria-selected={selected}>
            <td className="content-search-path"><code title={match.path}>{match.path}</code></td>
            <td className="content-search-line"><strong>{match.line}</strong></td>
            <td className="content-search-text"><code>{match.text}</code></td>
            <td className="content-search-row-actions"><div className="content-search-match-actions"><button type="button" className="table-action" onClick={() => selectMatch(match)} aria-label={`${match.path} ${match.line}行の前後を表示`}>前後を表示</button><button type="button" className="table-action" aria-pressed={reviewed} onClick={() => toggleReviewed(match)} aria-label={`${match.path} ${match.line}行を${reviewed ? "未確認に戻す" : "確認済みにする"}`}>{reviewed ? "✓ 確認済み" : "確認済みにする"}</button></div></td>
          </tr>;
        })}</tbody></table></div>}
        {selectedMatch && <section className="content-search-preview" aria-labelledby="content-search-preview-title">
          <div className="content-search-preview-heading">
            <div><h4 id="content-search-preview-title">一致行の前後を表示</h4><p><code>{selectedMatch.path}</code> · 行 {selectedMatch.line} · 固定版 <code>{pinnedHash ? shortHash(pinnedHash) : "未取得"}</code></p></div>
            <div className="content-search-preview-actions">{historyHref && <a className="subtle-button" href={historyHref} aria-label="固定した版でファイル履歴を調べる（自動取得しない）">ファイル履歴を調べる</a>}{investigationReport && <CopyButton value={investigationReport} label="選択した一致行のMarkdown調査レポートをコピー" />}</div>
          </div>
          <div className="content-search-navigation" role="group" aria-label="表示中の一致行の移動">
            <button type="button" className="subtle-button" disabled={navigation.previous === null} onClick={() => { if (navigation.previous) selectMatch(navigation.previous); }} aria-label="前の表示中の一致行へ">← 前の表示結果</button>
            <span role="status">{navigation.index >= 0 ? `選択 ${navigation.index + 1} / ${navigation.count} 件` : "選択中の一致行は表示条件外です"}</span>
            <button type="button" className="subtle-button" disabled={navigation.next === null} onClick={() => { if (navigation.next) selectMatch(navigation.next); }} aria-label="次の表示中の一致行へ">次の表示結果 →</button>
          </div>
          <div className="content-search-context-tools" role="group" aria-label="一致行の前後の表示とコピー">
            <label><span>前後に表示する行数</span><select value={contextRadius} onChange={(event) => setContextRadius(Number(event.target.value))} aria-label="一致行の前後に表示する行数">{CONTEXT_RADII.map((radius) => <option key={radius} value={radius}>{radius === 0 ? "一致行のみ" : `前後 ${radius} 行`}</option>)}</select></label>
            {previewState === "ready" && rawContext !== null && context && <CopyButton value={rawContext} label={`表示中の前後本文をコピー（行${context.start}–${context.end}）`} />}
            <button type="button" className="subtle-button" aria-pressed={reviewedKeys.has(contentSearchReviewKey(selectedMatch))} onClick={() => toggleReviewed(selectedMatch)}>{reviewedKeys.has(contentSearchReviewKey(selectedMatch)) ? "選択行を未確認に戻す" : "選択行を確認済みにする"}</button>
          </div>
          {previewState === "loading" && <p className="content-search-status" role="status">ファイル内容を取得中…</p>}
          {previewState === "error" && <p className="content-search-error" role="alert">一致行のファイルを取得できませんでした。{previewError && <span>（{previewError}）</span>}</p>}
          {previewState === "ready" && preview && <>
            {preview.binary ? <p className="content-search-note" role="status">このファイルはバイナリのため、テキスト前後を表示できません。</p> : preview.text === null ? <p className="content-search-empty" role="status">表示できる本文がありません。</p> : context && <div className="content-search-context" role="region" aria-label="一致行と前後のファイル内容" tabIndex={0}>{context.lines.map((line) => <div key={line.line} className={`content-search-context-line${line.highlight ? " is-match" : ""}`} data-line={line.line} data-highlighted={line.highlight ? "true" : "false"}><span className="content-search-context-number" aria-hidden="true">{line.line}</span><code>{line.text}</code>{line.highlight && <span className="content-search-highlight-label">一致</span>}</div>)}</div>}
            {preview.truncated && <p className="content-search-truncated" role="status">ファイル本文が {formatBytes(preview.download_limit)} を超えているため、先頭側のプレビューだけを表示しています。</p>}
            {context && selectedMatch.line > context.end && <p className="content-search-note" role="status">一致行はプレビュー上限の外にあるため、前後を表示できません。</p>}
          </>}
        </section>}
      </>}
    </div>
  </details>;
}

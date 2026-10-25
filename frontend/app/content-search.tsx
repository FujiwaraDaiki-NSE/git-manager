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
import "./content-search.css";

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
  };
};

const CONTENT_SEARCH_SORT_LABELS: Record<ContentSearchSort, string> = {
  git: "Git順",
  path: "パス順",
  line: "行番号順",
  text: "内容順",
};

const CONTEXT_RADIUS = 3;

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
  const visibleMatches = useMemo(() => contentSearchVisibleMatches(matches, {
    localQuery,
    pathFilter,
    sort,
  }) as ContentSearchMatch[], [localQuery, matches, pathFilter, sort]);
  const navigation = useMemo(() => adjacentContentSearchMatches(visibleMatches, selectedMatch) as {
    index: number;
    count: number;
    previous: ContentSearchMatch | null;
    next: ContentSearchMatch | null;
  }, [selectedMatch, visibleMatches]);
  const exportMetadata = useMemo<ContentSearchExportMetadata | null>(() => {
    if (!result || !pinnedHash) return null;
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
      },
    };
  }, [localQuery, matches.length, path, pathFilter, pinnedHash, result, sort, visibleMatches.length]);
  const pathLineList = useMemo(() => contentSearchPathLineList(visibleMatches) as string, [visibleMatches]);
  const context = selectedMatch && preview?.text !== null && preview?.text !== undefined
    ? contentSearchContext(preview.text, selectedMatch.line, CONTEXT_RADIUS) as ContentSearchContext
    : null;
  const investigationReport = exportMetadata && selectedMatch && previewState === "ready" && preview
    ? contentSearchInvestigationMarkdown(selectedMatch, exportMetadata, context && context.start <= context.end ? context : null, {
      binary: preview.binary,
      text_available: preview.text !== null,
      truncated: preview.truncated,
    }) as string
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
    setExportStatus("");
  };
  const hasLocalFilters = localQuery.trim() !== "" || pathFilter !== "" || sort !== "git";
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
          <span className="content-search-pinned"><code title={pinnedHash ?? undefined}>{pinnedHash ? shortHash(pinnedHash) : "固定版未取得"}</code></span>
          {exportStatus && <span>{exportStatus}</span>}
        </div>
        {result.truncated && <p className="content-search-truncated" role="status">結果は上限 {result.limit.toLocaleString()} 行または {formatBytes(result.byte_limit)} に達したため一部だけを表示しています。</p>}
        <div className="content-search-tools" role="group" aria-label="内容検索結果の操作">
          <label className="content-search-local-search"><span>取得済み一致行を検索（path / 内容）</span><input type="search" value={localQuery} onChange={(event) => setLocalQuery(event.target.value)} placeholder="pathまたは内容" aria-label="取得済み一致行をpathまたは内容で検索" /></label>
          <label><span>path（完全一致）</span><select value={pathFilter} onChange={(event) => setPathFilter(event.target.value)} aria-label="取得済み一致行をpathで完全一致絞り込み"><option value="">すべて</option>{paths.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          <label><span>表示順</span><select value={sort} onChange={(event) => setSort(event.target.value as ContentSearchSort)} aria-label="内容検索結果の表示順">{CONTENT_SEARCH_SORTS.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label>
          <div className="content-search-filter-actions">
            <button type="button" className="subtle-button" disabled={!hasLocalFilters} onClick={clearLocalFilters}>ローカル条件をリセット</button>
            <button type="button" className="subtle-button" disabled={visibleMatches.length === 0} onClick={() => downloadCsv(visibleMatches, setExportStatus)} aria-label="表示中の内容検索結果をCSV保存">表示中をCSV保存</button>
            <button type="button" className="subtle-button" disabled={visibleMatches.length === 0 || exportMetadata === null} onClick={() => { if (exportMetadata) downloadJson(visibleMatches, exportMetadata, setExportStatus); }} aria-label="表示中の内容検索結果をJSON保存">表示中をJSON保存</button>
            {visibleMatches.length > 0 && <CopyButton value={pathLineList} label="表示中のpath別行番号JSONをコピー" />}
          </div>
        </div>
        {selectedMatch && navigation.index < 0 && <p className="content-search-selection-note" role="status">選択中の一致行は現在のローカル条件外です。前後の表示結果へ移動できません。</p>}
        {matches.length === 0 ? <p className="content-search-empty" role="status">一致する行はありません。</p> : visibleMatches.length === 0 ? <p className="content-search-empty" role="status">ローカル条件に一致する行はありません。</p> : <div className="content-search-table-wrap" role="region" aria-label="内容検索の一致行" tabIndex={0}><table className="content-search-table"><thead><tr><th>ファイル</th><th>行</th><th>内容</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{visibleMatches.map((match, index) => {
          const selected = selectedMatch?.path === match.path && selectedMatch.line === match.line && selectedMatch.text === match.text;
          const key = contentSearchMatchKey(match, index) as string;
          return <tr key={key} className={selected ? "is-selected" : undefined} aria-selected={selected}>
            <td className="content-search-path"><code title={match.path}>{match.path}</code></td>
            <td className="content-search-line"><strong>{match.line}</strong></td>
            <td className="content-search-text"><code>{match.text}</code></td>
            <td className="content-search-row-actions"><button type="button" className="table-action" onClick={() => selectMatch(match)} aria-label={`${match.path} ${match.line}行の前後を表示`}>前後を表示</button></td>
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

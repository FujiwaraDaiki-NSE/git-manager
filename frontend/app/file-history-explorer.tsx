"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import CopyButton from "./copy-button";
import CommitFiles from "./commit-files";
import PatchView from "./patch-view";
import InvestigationPresets, { type FileHistoryPresetValues } from "./investigation-presets";
import {
  adjacentFileHistory,
  fileHistoryCommitMarkdown,
  fileHistoryDateRangeError,
  fileHistoryJson,
  filterFileHistoryInvestigation,
  FILE_HISTORY_CHANGE_ALL,
  FILE_HISTORY_CHANGE_KINDS,
  FILE_HISTORY_CHANGE_UNKNOWN,
  FILE_HISTORY_ORDER_GIT,
  FILE_HISTORY_ORDER_NEWEST,
  FILE_HISTORY_ORDER_OLDEST,
  FILE_HISTORY_ORDER_SUBJECT,
  FILE_HISTORY_TOPOLOGY_ALL,
  FILE_HISTORY_TOPOLOGY_MERGE,
  FILE_HISTORY_TOPOLOGY_NON_MERGE,
  sortFileHistory,
} from "./file-history-investigation-tools.mjs";
import {
  encodeFileHistoryAuthor,
  fileHistoryAuthors,
  fileHistoryCsv,
  fileHistoryHashList,
  fileHistoryQuery,
  fileHistoryRequestKey,
  hasUnknownFileHistoryAuthor,
  UNKNOWN_FILE_HISTORY_AUTHOR_FILTER,
} from "./file-history-tools.mjs";
import type { CommitDetail } from "./types";
import "./file-history-explorer.css";

type FileHistoryRecord = {
  hash: string;
  short: string;
  subject: string | null;
  author: string | null;
  date: string | null;
  parents: string[];
  status: string | null;
  path: string | null;
  old_path: string | null;
};

type FileHistoryPage = {
  commits: FileHistoryRecord[];
  file: string;
  revision: string;
  pinned_hash: string;
  follow: boolean;
  offset: number;
  has_more: boolean;
  next_offset: number | null;
  limit_reached: boolean;
};

type LoadState = "idle" | "loading" | "ready" | "error";
type FileHistoryOrder = "git" | "newest" | "oldest" | "subject";
type FileHistoryChangeKind = "all" | "unknown" | "A" | "M" | "D" | "R" | "C" | "T" | "U" | "X" | "B";
type FileHistoryTopology = "all" | "merge" | "nonmerge";

function exactDate(value: string | null) {
  if (!value) return "日時未取得";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "日時未取得" : date.toLocaleString("ja-JP");
}

function shortHash(value: string) {
  return value.slice(0, 8);
}

function statusLabel(value: string | null) {
  if (!value) return "変更情報未取得";
  if (value.startsWith("R")) return `名前変更 (${value.slice(1) || "検出"})`;
  if (value.startsWith("C")) return `コピー (${value.slice(1) || "検出"})`;
  return value;
}

function displayedPath(record: FileHistoryRecord) {
  if (record.old_path && record.path && record.old_path !== record.path) {
    return `${record.old_path} → ${record.path}`;
  }
  return record.path || "パス未取得";
}

function recordKey(record: FileHistoryRecord, index: number) {
  return `${record.hash}:${record.path ?? ""}:${index}`;
}

async function responseError(response: Response) {
  try {
    const body = await response.json() as { detail?: unknown };
    if (typeof body.detail === "string" && body.detail) return body.detail;
  } catch {
    // The status below is still useful when a proxy returns non-JSON text.
  }
  return `HTTP ${response.status}`;
}

function downloadCsv(records: FileHistoryRecord[], setStatus: (message: string) => void) {
  try {
    const url = URL.createObjectURL(new Blob([fileHistoryCsv(records)], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "gitdash-file-history.csv";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(`${records.length}件のCSV保存を開始しました。`);
  } catch {
    setStatus("CSVを保存できませんでした。");
  }
}

function downloadJson(
  records: FileHistoryRecord[],
  metadata: { revision: string; pinnedHash: string; file: string; follow: boolean },
  setStatus: (message: string) => void,
) {
  try {
    const url = URL.createObjectURL(new Blob([fileHistoryJson(records, metadata)], { type: "application/json;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "gitdash-file-history.json";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(`${records.length}件のJSON保存を開始しました。固定リビジョンを含みます。`);
  } catch {
    setStatus("JSONを保存できませんでした。");
  }
}

function CommitDetailPane({
  path,
  file,
  hash,
  record,
  revision,
  pinnedHash,
  follow,
}: {
  path: string;
  file: string;
  hash: string;
  record: FileHistoryRecord | null;
  revision: string;
  pinnedHash: string | null;
  follow: boolean;
}) {
  const [state, setState] = useState<LoadState>("loading");
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState("loading");
    setDetail(null);
    setError(null);
    void fetch(`/api/repo/commit?path=${encodeURIComponent(path)}&hash=${encodeURIComponent(hash)}`, {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(await responseError(response));
      return await response.json() as CommitDetail;
    }).then((value) => {
      if (controller.signal.aborted) return;
      setDetail(value);
      setState("ready");
    }).catch((caught: unknown) => {
      if (controller.signal.aborted) return;
      setError(caught instanceof Error ? caught.message : "unknown error");
      setState("error");
    });
    return () => controller.abort();
  }, [hash, path, retry]);

  return <section className="file-history-commit" aria-labelledby="file-history-commit-title">
    <div className="file-history-commit-heading">
      <div>
        <h4 id="file-history-commit-title">コミット詳細</h4>
        <code>{hash}</code>
      </div>
      <div className="file-history-commit-actions">
        <CopyButton value={hash} label="コミットIDをコピー" />
        {state === "ready" && detail && record && pinnedHash && <CopyButton
          value={fileHistoryCommitMarkdown(detail, {
            repositoryPath: path,
            file,
            record,
            revision,
            pinnedHash,
            follow,
          })}
          label="選択したコミットのMarkdownレポートをコピー"
        />}
      </div>
    </div>
    {state === "loading" && <p role="status">コミット詳細を取得中…</p>}
    {state === "error" && <p className="file-history-error" role="alert">コミット詳細を取得できませんでした。{error && <span>（{error}）</span>}<button type="button" className="subtle-button" onClick={() => setRetry((value) => value + 1)}>再取得</button></p>}
    {state === "ready" && detail && <>
      <div className="file-history-commit-meta"><strong>{detail.subject || "件名未取得"}</strong><span>{detail.author || "author 未取得"}</span><time dateTime={detail.date || undefined}>{exactDate(detail.date)}</time></div>
      <CommitFiles key={detail.hash} files={detail.files} downloadName={`${detail.hash}-files.tsv`} />
      <PatchView key={detail.hash} patch={detail.patch} />
      {detail.patch_truncated && <p className="file-history-note" role="status">差分が大きいため一部を省略しています。全体は <code>git show {hash}</code> で確認できます。</p>}
    </>}
  </section>;
}

export default function FileHistoryExplorer({ path }: { path: string }) {
  const [revision, setRevision] = useState("");
  const [file, setFile] = useState("");
  const [follow, setFollow] = useState(false);
  const [query, setQuery] = useState("");
  const [authorFilter, setAuthorFilter] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [order, setOrder] = useState<FileHistoryOrder>(FILE_HISTORY_ORDER_GIT);
  const [changeKind, setChangeKind] = useState<FileHistoryChangeKind>(FILE_HISTORY_CHANGE_ALL);
  const [topology, setTopology] = useState<FileHistoryTopology>(FILE_HISTORY_TOPOLOGY_ALL);
  const [records, setRecords] = useState<FileHistoryRecord[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [pinnedHash, setPinnedHash] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [limitReached, setLimitReached] = useState(false);
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState("");
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const requestControllerRef = useRef<AbortController | null>(null);
  const requestKeyRef = useRef<string | null>(null);
  const [open, setOpen] = useState(false);

  // A repository path change starts a new investigation context. Abort any
  // in-flight page and clear every result/filter/detail tied to the old repo.
  useEffect(() => {
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    requestKeyRef.current = null;
    setRevision("");
    setFile("");
    setFollow(false);
    setQuery("");
    setAuthorFilter("");
    setStartDate("");
    setEndDate("");
    setOrder(FILE_HISTORY_ORDER_GIT);
    setChangeKind(FILE_HISTORY_CHANGE_ALL);
    setTopology(FILE_HISTORY_TOPOLOGY_ALL);
    setRecords([]);
    setNextOffset(null);
    setPinnedHash(null);
    setHasMore(false);
    setLimitReached(false);
    setState("idle");
    setError(null);
    setExportStatus("");
    setSelectedHash(null);
    setOpen(false);
  }, [path]);

  // Editing the investigation inputs also invalidates the current page. This
  // prevents a response for the previous revision/path/follow mode from
  // appearing beside the newly entered values.
  useEffect(() => {
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    requestKeyRef.current = null;
    setRecords([]);
    setNextOffset(null);
    setPinnedHash(null);
    setHasMore(false);
    setLimitReached(false);
    setState("idle");
    setError(null);
    setExportStatus("");
    setSelectedHash(null);
  }, [file, follow, revision]);

  const authors = useMemo(() => fileHistoryAuthors(records) as string[], [records]);
  const includesUnknownAuthor = useMemo(() => hasUnknownFileHistoryAuthor(records) as boolean, [records]);
  const dateRangeError = useMemo(() => fileHistoryDateRangeError(startDate, endDate) as string | null, [endDate, startDate]);
  const filtered = useMemo(() => filterFileHistoryInvestigation(records, {
    query,
    authorFilter,
    startDate,
    endDate,
    changeKind,
    topology,
  }) as FileHistoryRecord[], [authorFilter, changeKind, endDate, query, records, startDate, topology]);
  const visibleRecords = useMemo(() => sortFileHistory(filtered, order) as FileHistoryRecord[], [filtered, order]);
  const navigation = useMemo(() => adjacentFileHistory(visibleRecords, selectedHash), [selectedHash, visibleRecords]);
  const selectedRecord = useMemo(() => selectedHash === null ? null : records.find((record) => record.hash === selectedHash) ?? null, [records, selectedHash]);
  const activeKey = useMemo(() => fileHistoryRequestKey(path, revision, file, follow), [file, follow, path, revision]);

  useEffect(() => {
    setExportStatus("");
  }, [authorFilter, changeKind, endDate, order, query, startDate, topology]);

  const load = async (offset: number, initial: boolean) => {
    if (state === "loading" && initial === false) return;
    if (!revision || !file) return;
    let selectedRevision: string;
    if (initial) {
      selectedRevision = revision;
    } else if (pinnedHash === null) {
      setError("次のページを取得する固定リビジョンがありません。最初から履歴を取得してください。");
      setState("error");
      return;
    } else {
      selectedRevision = pinnedHash;
    }
    const requestKey = activeKey;
    if (requestKey === null) return;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    requestKeyRef.current = requestKey;
    setState("loading");
    setError(null);
    if (initial) {
      setRecords([]);
      setNextOffset(null);
      setPinnedHash(null);
      setHasMore(false);
      setLimitReached(false);
      setSelectedHash(null);
    }
    const params = fileHistoryQuery(path, selectedRevision, file, follow, offset);
    try {
      const response = await fetch(`/api/repo/file-history?${params}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(await responseError(response));
      const page = await response.json() as FileHistoryPage;
      if (controller.signal.aborted || requestKeyRef.current !== requestKey) return;
      setRecords((current) => {
        if (initial) return page.commits;
        const known = new Set(current.map((record) => record.hash));
        return [...current, ...page.commits.filter((record) => !known.has(record.hash))];
      });
      setPinnedHash(page.pinned_hash);
      setNextOffset(page.next_offset);
      setHasMore(page.has_more);
      setLimitReached(page.limit_reached);
      setState("ready");
    } catch (caught: unknown) {
      if (controller.signal.aborted || requestKeyRef.current !== requestKey) return;
      setError(caught instanceof Error ? caught.message : "unknown error");
      setState("error");
    } finally {
      if (requestControllerRef.current === controller && requestKeyRef.current === requestKey) {
        requestControllerRef.current = null;
      }
    }
  };

  const run = () => {
    setExportStatus("");
    void load(0, true);
  };

  const loadMore = () => {
    if (nextOffset === null || !hasMore) return;
    void load(nextOffset, false);
  };

  const clearFilters = () => {
    setQuery("");
    setAuthorFilter("");
    setStartDate("");
    setEndDate("");
    setOrder(FILE_HISTORY_ORDER_GIT);
    setChangeKind(FILE_HISTORY_CHANGE_ALL);
    setTopology(FILE_HISTORY_TOPOLOGY_ALL);
    setExportStatus("");
  };

  const applyPreset = (values: FileHistoryPresetValues) => {
    setRevision(values.revision);
    setFile(values.file);
    setFollow(values.follow);
    setQuery("");
    setAuthorFilter("");
    setStartDate("");
    setEndDate("");
    setOrder(FILE_HISTORY_ORDER_GIT);
    setChangeKind(FILE_HISTORY_CHANGE_ALL);
    setTopology(FILE_HISTORY_TOPOLOGY_ALL);
    setOpen(true);
  };

  const exportMetadata = pinnedHash === null ? null : { revision, pinnedHash, file, follow };
  const hasFilters = query.trim() !== ""
    || authorFilter !== ""
    || startDate !== ""
    || endDate !== ""
    || order !== FILE_HISTORY_ORDER_GIT
    || changeKind !== FILE_HISTORY_CHANGE_ALL
    || topology !== FILE_HISTORY_TOPOLOGY_ALL;
  const canRun = revision.trim() !== "" && file.trim() !== "" && state !== "loading";

  return <details className="file-history-explorer" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary id="file-history-explorer-title">ファイルの履歴を調べる <span>明示したリビジョン・名前変更・CSV</span></summary>
      <div className="file-history-explorer-body">
        <div className="file-history-heading">
          <div>
            <h3>ファイルに関係するコミットを確認</h3>
            <p>リビジョンとリポジトリ相対パスを入力して実行します。HEADやブランチ名も指定できます。</p>
          </div>
          <code className="file-history-repo" title={path}>{path}</code>
        </div>

        <InvestigationPresets
          kind="file-history"
          repoPath={path}
          values={{ revision, file, follow }}
          onApply={(values) => applyPreset(values as FileHistoryPresetValues)}
        />

        <div className="file-history-inputs" role="group" aria-label="ファイル履歴の対象">
          <label><span>リビジョン（必須）</span><input type="text" value={revision} onChange={(event) => setRevision(event.target.value)} placeholder="HEAD、ブランチ名、完全ハッシュ" aria-label="ファイル履歴のリビジョン" /></label>
          <label><span>ファイル相対パス（必須）</span><input type="text" value={file} onChange={(event) => setFile(event.target.value)} placeholder="src/example.ts" aria-label="ファイル履歴のファイル相対パス" /></label>
          <label className="file-history-follow"><input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} /><span>名前変更を追跡</span></label>
          <button type="button" className="primary-action" disabled={!canRun} onClick={run}>{state === "loading" ? "履歴を取得中…" : "履歴を取得"}</button>
        </div>
        <p className="file-history-follow-note">「名前変更を追跡」はGitが検出した名前変更を、入力したパスから過去へたどります。無効時は入力したパスそのものだけを調べます。コピーや類似度が低い変更はGitが名前変更と判定しないことがあります。</p>

        {state === "error" && <p className="file-history-error" role="alert">ファイル履歴を取得できませんでした。{error && <span>（{error}）</span>} 入力とGitの状態を確認して再実行してください。</p>}
        {(state === "ready" || (state === "loading" && records.length > 0) || (state === "error" && records.length > 0)) && <>
          <div className="file-history-tools" role="group" aria-label="取得済み履歴の絞り込み">
            <label><span>履歴内検索</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="件名・パス・ハッシュ" aria-label="取得済みファイル履歴を検索" /></label>
            <label><span>作成者（完全一致）</span><select value={authorFilter} onChange={(event) => setAuthorFilter(event.target.value)} aria-label="取得済みファイル履歴を作成者で絞り込み"><option value="">すべて</option>{authors.map((author) => <option key={author} value={encodeFileHistoryAuthor(author)}>{author}</option>)}{includesUnknownAuthor && <option value={UNKNOWN_FILE_HISTORY_AUTHOR_FILTER}>作成者未取得</option>}</select></label>
            <label><span>開始日（ローカル）</span><input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} aria-label="ファイル履歴の開始日（ローカル）" aria-invalid={Boolean(dateRangeError)} /></label>
            <label><span>終了日（ローカル）</span><input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} aria-label="ファイル履歴の終了日（ローカル）" aria-invalid={Boolean(dateRangeError)} /></label>
            <label><span>変更種別</span><select value={changeKind} onChange={(event) => setChangeKind(event.target.value as FileHistoryChangeKind)} aria-label="ファイル履歴の変更種別で絞り込み"><option value={FILE_HISTORY_CHANGE_ALL}>すべて</option>{FILE_HISTORY_CHANGE_KINDS.map((kind) => <option key={kind} value={kind}>{kind}{kind === "A" ? " 追加" : kind === "M" ? "変更" : kind === "D" ? "削除" : kind === "R" ? "名前変更" : kind === "C" ? "コピー" : kind === "T" ? "タイプ変更" : kind === "U" ? "未解決" : kind === "X" ? "種別不明" : "対応関係の分断"}</option>)}<option value={FILE_HISTORY_CHANGE_UNKNOWN}>不明</option></select></label>
            <label><span>トポロジー</span><select value={topology} onChange={(event) => setTopology(event.target.value as FileHistoryTopology)} aria-label="ファイル履歴のマージトポロジーで絞り込み"><option value={FILE_HISTORY_TOPOLOGY_ALL}>すべて</option><option value={FILE_HISTORY_TOPOLOGY_MERGE}>マージのみ</option><option value={FILE_HISTORY_TOPOLOGY_NON_MERGE}>非マージのみ</option></select></label>
            <label><span>並び順</span><select value={order} onChange={(event) => setOrder(event.target.value as FileHistoryOrder)} aria-label="ファイル履歴の並び順"><option value={FILE_HISTORY_ORDER_GIT}>Gitの順序</option><option value={FILE_HISTORY_ORDER_NEWEST}>新しい順</option><option value={FILE_HISTORY_ORDER_OLDEST}>古い順</option><option value={FILE_HISTORY_ORDER_SUBJECT}>subject順</option></select></label>
            <button type="button" className="subtle-button" disabled={!hasFilters} onClick={clearFilters}>条件をリセット</button>
            <button type="button" className="subtle-button" disabled={visibleRecords.length === 0} onClick={() => downloadCsv(visibleRecords, setExportStatus)}>一致する履歴をCSV保存</button>
            <button type="button" className="subtle-button" disabled={visibleRecords.length === 0 || exportMetadata === null} onClick={() => exportMetadata && downloadJson(visibleRecords, exportMetadata, setExportStatus)}>一致する履歴をJSON保存</button>
            {visibleRecords.length > 0 && <CopyButton value={fileHistoryHashList(visibleRecords)} label="一致するコミットのハッシュをコピー" />}
          </div>
          <div className="file-history-coverage" role="status"><span>{visibleRecords.length} / {records.length} 件を表示</span><span>{follow ? "名前変更を追跡中" : "入力パスのみ"}</span><span>{limitReached ? "取得上限に達しました。残りの履歴はターミナルで確認してください。" : hasMore ? "追加ページあり" : "すべて取得済み"}</span>{dateRangeError && <span>ローカル日付範囲が無効です。</span>}{exportStatus && <span>{exportStatus}</span>}</div>
          {dateRangeError && <p className="file-history-date-error" role="alert">{dateRangeError}</p>}
          {visibleRecords.length === 0 ? <p className="file-history-empty" role="status">{records.length === 0 ? "一致するコミットはありません。" : dateRangeError ? "日付範囲が無効なため、履歴を表示できません。" : "条件に一致する取得済み履歴はありません。"}</p> : <div className="file-history-table-wrap" role="region" aria-label="ファイル履歴" tabIndex={0}><table className="file-history-table"><thead><tr><th>ハッシュ</th><th>件名</th><th>作成者</th><th>日時</th><th>変更</th><th>パス</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{visibleRecords.map((record, index) => <tr key={recordKey(record, index)} className={record.hash === selectedHash ? "is-selected" : undefined}><td className="file-history-hash"><code title={record.hash}>{shortHash(record.hash)}</code><CopyButton value={record.hash} label={`${shortHash(record.hash)} をコピー`} /></td><td>{record.subject || "件名未取得"}</td><td>{record.author || "作成者未取得"}</td><td><time dateTime={record.date || undefined}>{exactDate(record.date)}</time></td><td>{statusLabel(record.status)}</td><td className="file-history-path" title={displayedPath(record)}>{displayedPath(record)}</td><td><button type="button" className="table-action" onClick={() => setSelectedHash(record.hash)}>コミットを表示</button></td></tr>)}</tbody></table></div>}
          {hasMore && nextOffset !== null && <button type="button" className="file-history-more" onClick={loadMore} disabled={state === "loading"}>{state === "loading" ? "追加履歴を取得中…" : "さらに履歴を取得"}</button>}
          <div className="file-history-navigation" role="group" aria-label="表示中コミットの移動">
            <button type="button" className="subtle-button" onClick={() => navigation.previous && setSelectedHash(navigation.previous.hash)} disabled={navigation.previous === null} aria-label="前の表示中コミットを選択">← 前のコミット</button>
            <span role="status">{navigation.index >= 0 ? `選択 ${navigation.index + 1} / ${navigation.count}` : selectedHash ? "選択中コミットは現在の条件外" : "コミットを選択してください"}</span>
            <button type="button" className="subtle-button" onClick={() => navigation.next && setSelectedHash(navigation.next.hash)} disabled={navigation.next === null} aria-label="次の表示中コミットを選択">次のコミット →</button>
          </div>
          {selectedHash && <CommitDetailPane key={selectedHash} path={path} file={file} hash={selectedHash} record={selectedRecord} revision={revision} pinnedHash={pinnedHash} follow={follow} />}
        </>}
        {state === "idle" && <p className="file-history-empty" role="status">対象を入力して履歴を取得してください。</p>}
      </div>
  </details>;
}


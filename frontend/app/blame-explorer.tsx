"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import CommitFiles from "./commit-files";
import CopyButton from "./copy-button";
import PatchView from "./patch-view";
import type { CommitDetail } from "./types";
import {
  MAX_BLAME_LINES,
  UNKNOWN_BLAME_AUTHOR_FILTER,
  blameAuthors,
  blameCommits,
  blameCsv,
  blameHashList,
  blameQuery,
  blameRequestKey,
  blameTime,
  encodeBlameAuthor,
  hasUnknownBlameAuthor,
} from "./blame-explorer-tools.mjs";
import {
  BLAME_LINE_ORDER_CURRENT,
  blameCommitSummary,
  blameJson,
  blameRawLineContent,
  blameRawLineContentIsNonContiguous,
  filterBlameInvestigationLines,
  orderBlameLines,
  visibleBlameCommitHashes,
} from "./blame-investigation-tools.mjs";
import "./blame-explorer.css";

type BlameLine = {
  original_line: number;
  final_line: number;
  commit: string;
  author: string | null;
  email: string | null;
  time: number;
  content: string;
  summary: string;
  path: string;
};

type BlameResponse = {
  revision: string;
  pinned_hash: string;
  source_file: string;
  start: number;
  end: number;
  lines: BlameLine[];
};

type LoadState = "idle" | "loading" | "ready" | "error";

function shortHash(value: string) {
  return value.slice(0, 10);
}

async function responseError(response: Response) {
  try {
    const body = await response.json() as { detail?: unknown };
    if (typeof body.detail === "string" && body.detail) return body.detail;
  } catch {
    // A proxy may return a non-JSON error; the status below still helps.
  }
  return `HTTP ${response.status}`;
}

function parseLineNumber(value: string, label: string) {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${label}は1以上の整数で指定してください。`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label}が大きすぎます。`);
  return number;
}

function downloadCsv(lines: BlameLine[], setStatus: (message: string) => void) {
  try {
    const url = URL.createObjectURL(new Blob([blameCsv(lines)], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "gitdash-blame.csv";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(`${lines.length}行のCSV保存を開始しました。`);
  } catch {
    setStatus("CSVを保存できませんでした。");
  }
}

function downloadJson(lines: BlameLine[], metadata: Record<string, unknown>, setStatus: (message: string) => void) {
  try {
    const url = URL.createObjectURL(new Blob([blameJson(lines, metadata)], { type: "application/json;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "gitdash-blame.json";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(`${lines.length}行のJSON保存を開始しました。`);
  } catch {
    setStatus("JSONを保存できませんでした。調査条件を確認してください。");
  }
}

function CommitDetailPane({
  path,
  hash,
  visibleCommitHashes,
  onSelectHash,
}: {
  path: string;
  hash: string;
  visibleCommitHashes: string[];
  onSelectHash: (nextHash: string) => void;
}) {
  const [state, setState] = useState<LoadState>("loading");
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const visibleIndex = visibleCommitHashes.indexOf(hash);
  const selectedCommitIsVisible = visibleIndex >= 0;
  const previousHash = selectedCommitIsVisible && visibleIndex > 0 ? visibleCommitHashes[visibleIndex - 1] : null;
  const nextHash = selectedCommitIsVisible && visibleIndex < visibleCommitHashes.length - 1 ? visibleCommitHashes[visibleIndex + 1] : null;

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

  return <section className="blame-commit" aria-labelledby="blame-commit-title">
    <div className="blame-commit-heading">
      <div>
        <h4 id="blame-commit-title">変更元コミット</h4>
        <code>{hash}</code>
      </div>
      <CopyButton value={hash} label="変更元コミットIDをコピー" />
    </div>
    <div className="blame-commit-navigation" role="group" aria-label="表示中コミットの移動">
      <button type="button" className="subtle-button" disabled={previousHash === null} onClick={() => { if (previousHash !== null) onSelectHash(previousHash); }} aria-label="前の表示コミット">前の表示コミット</button>
      <span role="status">{selectedCommitIsVisible ? `${visibleIndex + 1} / ${visibleCommitHashes.length} 件` : "現在の絞り込み結果にありません"}</span>
      <button type="button" className="subtle-button" disabled={nextHash === null} onClick={() => { if (nextHash !== null) onSelectHash(nextHash); }} aria-label="次の表示コミット">次の表示コミット</button>
    </div>
    {!selectedCommitIsVisible && <p className="blame-note" role="status">選択中のコミットは現在の絞り込み結果から非表示です。前後の表示コミットへ移動できません。</p>}
    {state === "loading" && <p role="status">コミット詳細を取得中…</p>}
    {state === "error" && <p className="blame-error" role="alert">コミット詳細を取得できませんでした。{error && <span>（{error}）</span>}<button type="button" className="subtle-button" onClick={() => setRetry((value) => value + 1)}>再取得</button></p>}
    {state === "ready" && detail && <>
      <div className="blame-commit-meta"><strong>{detail.subject || "件名未取得"}</strong><span>{detail.author || "author 未取得"}</span><time dateTime={detail.date || undefined}>{detail.date ? new Date(detail.date).toLocaleString("ja-JP") : "日時未取得"}</time></div>
      <CommitFiles key={detail.hash} files={detail.files} downloadName={`${detail.hash}-files.tsv`} />
      <PatchView key={detail.hash} patch={detail.patch} />
      {detail.patch_truncated && <p className="blame-note" role="status">差分が大きいため一部を省略しています。全体は <code>git show {hash}</code> で確認できます。</p>}
    </>}
  </section>;
}

export default function BlameExplorer({ path }: { path: string }) {
  const [revision, setRevision] = useState("");
  const [file, setFile] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [query, setQuery] = useState("");
  const [authorFilter, setAuthorFilter] = useState("");
  const [commitFilter, setCommitFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [subsetStart, setSubsetStart] = useState("");
  const [subsetEnd, setSubsetEnd] = useState("");
  const [lineOrder, setLineOrder] = useState(BLAME_LINE_ORDER_CURRENT);
  const [lines, setLines] = useState<BlameLine[]>([]);
  const [pinnedHash, setPinnedHash] = useState<string | null>(null);
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState("");
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const requestControllerRef = useRef<AbortController | null>(null);
  const requestKeyRef = useRef<string | null>(null);
  const [open, setOpen] = useState(false);

  // A repository or investigation input change invalidates all rows tied to
  // the previous immutable snapshot and aborts its in-flight request.
  useEffect(() => {
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    requestKeyRef.current = null;
    setRevision("");
    setFile("");
    setStart("");
    setEnd("");
    setQuery("");
    setAuthorFilter("");
    setCommitFilter("");
    setDateFrom("");
    setDateTo("");
    setSubsetStart("");
    setSubsetEnd("");
    setLineOrder(BLAME_LINE_ORDER_CURRENT);
    setLines([]);
    setPinnedHash(null);
    setRange(null);
    setState("idle");
    setError(null);
    setExportStatus("");
    setSelectedHash(null);
    setOpen(false);
  }, [path]);

  useEffect(() => {
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    requestKeyRef.current = null;
    setLines([]);
    setPinnedHash(null);
    setRange(null);
    setState("idle");
    setError(null);
    setExportStatus("");
    setSelectedHash(null);
  }, [file, revision, start, end]);

  const authors = useMemo(() => blameAuthors(lines) as string[], [lines]);
  const commits = useMemo(() => blameCommits(lines) as string[], [lines]);
  const includesUnknownAuthor = useMemo(() => hasUnknownBlameAuthor(lines) as boolean, [lines]);
  const filteredState = useMemo(() => {
    try {
      const localFiltered = filterBlameInvestigationLines(lines, {
        query,
        authorFilter,
        commitFilter,
        dateFrom,
        dateTo,
        subsetStart,
        subsetEnd,
      });
      return { lines: orderBlameLines(localFiltered, lineOrder) as BlameLine[], error: null };
    } catch (caught: unknown) {
      return { lines: [] as BlameLine[], error: caught instanceof Error ? caught.message : "絞り込み条件を確認してください。" };
    }
  }, [authorFilter, commitFilter, dateFrom, dateTo, lineOrder, lines, query, subsetEnd, subsetStart]);
  const filtered = filteredState.lines;
  const filterError = filteredState.error;
  const visibleCommitHashes = useMemo(() => visibleBlameCommitHashes(filtered) as string[], [filtered]);
  const contributionSummary = useMemo(() => blameCommitSummary(filtered) as Array<{ commit: string; lineCount: number; percent: number }>, [filtered]);
  const rawContent = useMemo(() => blameRawLineContent(filtered), [filtered]);
  const rawContentIsNonContiguous = useMemo(() => blameRawLineContentIsNonContiguous(filtered), [filtered]);
  const hasFilters = query.trim() !== "" || authorFilter !== "" || commitFilter !== "" || dateFrom !== "" || dateTo !== "" || subsetStart !== "" || subsetEnd !== "" || lineOrder !== BLAME_LINE_ORDER_CURRENT;

  const run = () => {
    let selectedStart: number;
    let selectedEnd: number;
    try {
      selectedStart = parseLineNumber(start, "開始行");
      selectedEnd = parseLineNumber(end, "終了行");
      if (selectedEnd < selectedStart) throw new Error("終了行は開始行以上で指定してください。");
      if (selectedEnd - selectedStart + 1 > MAX_BLAME_LINES) throw new Error(`1回に取得できる行数は${MAX_BLAME_LINES}行以下です。`);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "行範囲を確認してください。");
      setState("error");
      return;
    }
    if (!revision || !file) {
      setError("リビジョンとファイル相対パスを入力してください。");
      setState("error");
      return;
    }
    const requestKey = blameRequestKey(path, revision, file, selectedStart, selectedEnd);
    if (requestKey === null) {
      setError("調査条件を確認してください。");
      setState("error");
      return;
    }
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    requestKeyRef.current = requestKey;
    setState("loading");
    setError(null);
    setLines([]);
    setPinnedHash(null);
    setRange(null);
    setSelectedHash(null);
    setExportStatus("");
    const params = blameQuery(path, revision, file, selectedStart, selectedEnd);
    void fetch(`/api/repo/blame?${params}`, { cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(await responseError(response));
      return await response.json() as BlameResponse;
    }).then((result) => {
      if (controller.signal.aborted || requestKeyRef.current !== requestKey) return;
      setLines(result.lines);
      setPinnedHash(result.pinned_hash);
      setRange({ start: result.start, end: result.end });
      setState("ready");
    }).catch((caught: unknown) => {
      if (controller.signal.aborted || requestKeyRef.current !== requestKey) return;
      setError(caught instanceof Error ? caught.message : "unknown error");
      setState("error");
    }).finally(() => {
      if (requestControllerRef.current === controller && requestKeyRef.current === requestKey) requestControllerRef.current = null;
    });
  };

  const clearFilters = () => {
    setQuery("");
    setAuthorFilter("");
    setCommitFilter("");
    setDateFrom("");
    setDateTo("");
    setSubsetStart("");
    setSubsetEnd("");
    setLineOrder(BLAME_LINE_ORDER_CURRENT);
    setExportStatus("");
  };

  return <details className="blame-explorer" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary id="blame-explorer-title">行ごとの変更元を調べる <span>明示した版・範囲・CSV/JSON</span></summary>
    <div className="blame-explorer-body">
      <div className="blame-heading">
        <div>
          <h3>ファイルの各行をどのコミットが変更したか確認</h3>
          <p>リビジョン、リポジトリ相対パス、1始まりの行範囲をすべて指定して実行します。指定した版のGitオブジェクトだけを読み取ります。</p>
        </div>
        <code className="blame-repo" title={path}>{path}</code>
      </div>

      <div className="blame-inputs" role="group" aria-label="行帰属の対象">
        <label><span>リビジョン（必須）</span><input type="text" value={revision} onChange={(event) => setRevision(event.target.value)} placeholder="HEAD、ブランチ名、完全ハッシュ" aria-label="行帰属のリビジョン" /></label>
        <label><span>ファイル相対パス（必須）</span><input type="text" value={file} onChange={(event) => setFile(event.target.value)} placeholder="src/example.ts" aria-label="行帰属のファイル相対パス" /></label>
        <label className="blame-line-number"><span>開始行（必須）</span><input type="text" inputMode="numeric" value={start} onChange={(event) => setStart(event.target.value)} placeholder="1" aria-label="行帰属の開始行" /></label>
        <label className="blame-line-number"><span>終了行（必須）</span><input type="text" inputMode="numeric" value={end} onChange={(event) => setEnd(event.target.value)} placeholder="20" aria-label="行帰属の終了行" /></label>
        <button type="button" className="primary-action" disabled={state === "loading"} onClick={run}>{state === "loading" ? "行帰属を取得中…" : "行帰属を取得"}</button>
      </div>
      <p className="blame-input-note">1回に取得できる範囲は最大{MAX_BLAME_LINES}行です。バイナリ、シンボリックリンク、Gitリンクは対象外です。</p>

      {state === "error" && <p className="blame-error" role="alert">行帰属を取得できませんでした。{error && <span>（{error}）</span>}</p>}
      {(state === "ready" || (state === "loading" && lines.length > 0) || (state === "error" && lines.length > 0)) && <>
        <div className="blame-tools" role="group" aria-label="取得済み行の絞り込み">
          <label className="blame-search"><span>取得済み行を検索</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="内容・件名・パス・ハッシュ" aria-label="取得済み行を検索" /></label>
          <label><span>作成者（完全一致）</span><select value={authorFilter} onChange={(event) => setAuthorFilter(event.target.value)} aria-label="取得済み行を作成者で絞り込み"><option value="">すべて</option>{authors.map((author) => <option key={author} value={encodeBlameAuthor(author)}>{author}</option>)}{includesUnknownAuthor && <option value={UNKNOWN_BLAME_AUTHOR_FILTER}>作成者未取得</option>}</select></label>
          <label><span>コミット（完全一致）</span><select value={commitFilter} onChange={(event) => setCommitFilter(event.target.value)} aria-label="取得済み行をコミットで絞り込み"><option value="">すべて</option>{commits.map((commit) => <option key={commit} value={commit}>{shortHash(commit)}</option>)}</select></label>
          <label><span>コミット日時（開始日）</span><input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} aria-label="コミット日時の開始日" /></label>
          <label><span>コミット日時（終了日）</span><input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} aria-label="コミット日時の終了日" /></label>
          <label className="blame-line-number"><span>表示開始行（任意）</span><input type="text" inputMode="numeric" value={subsetStart} onChange={(event) => setSubsetStart(event.target.value)} placeholder="空欄 = 制限なし" aria-label="取得済み行の表示開始行" /></label>
          <label className="blame-line-number"><span>表示終了行（任意）</span><input type="text" inputMode="numeric" value={subsetEnd} onChange={(event) => setSubsetEnd(event.target.value)} placeholder="空欄 = 制限なし" aria-label="取得済み行の表示終了行" /></label>
          <label><span>行の並び順</span><select value={lineOrder} onChange={(event) => setLineOrder(event.target.value)} aria-label="取得済み行の並び順"><option value="current-ascending">現在行の昇順</option><option value="original-ascending">原文行の昇順</option><option value="newest">コミット日時の新しい順</option><option value="oldest">コミット日時の古い順</option></select></label>
          <button type="button" className="subtle-button" disabled={!hasFilters} onClick={clearFilters}>条件をリセット</button>
          <button type="button" className="subtle-button" disabled={filtered.length === 0} onClick={() => downloadCsv(filtered, setExportStatus)}>一致する行をCSV保存</button>
          <button type="button" className="subtle-button" disabled={filtered.length === 0 || range === null} onClick={() => { if (range !== null) downloadJson(filtered, { repo: path, revision, pinned_hash: pinnedHash, file, requested_range: range, filters: { query, author: authorFilter, commit: commitFilter, commit_date_from: dateFrom, commit_date_to: dateTo, line_start: subsetStart, line_end: subsetEnd, order: lineOrder } }, setExportStatus); }}>一致する行をJSON保存</button>
          {filtered.length > 0 && <CopyButton value={blameHashList(filtered)} label="一致する変更元コミットをコピー" />}
          {filtered.length > 0 && <CopyButton value={rawContent} label="表示中の行内容をコピー" />}
        </div>
        {filterError && <p className="blame-error" role="alert">絞り込み条件を確認してください。<span>（{filterError}）</span></p>}
        <div className="blame-coverage" role="status"><span>{filtered.length} / {lines.length} 行を表示</span>{range && <span>取得範囲 行 {range.start}–{range.end}</span>}{pinnedHash && <span className="blame-pinned"><code title={pinnedHash}>{shortHash(pinnedHash)}</code><CopyButton value={pinnedHash} label="固定したコミットIDをコピー" /></span>}{exportStatus && <span>{exportStatus}</span>}</div>
        {rawContentIsNonContiguous && filtered.length > 0 && <p className="blame-note blame-inline-note" role="status">表示中の行は連続していないため、行内容のコピーには表示順の行間だけ改行を入れます。途中の非表示行は含まれません。</p>}
        {filtered.length > 0 && <section className="blame-summary" aria-labelledby="blame-summary-title"><div className="blame-summary-heading"><h4 id="blame-summary-title">表示中のコミット別寄与</h4><span>{filtered.length}行を集計</span></div><ul className="blame-summary-list">{contributionSummary.map((summary) => <li key={summary.commit} className="blame-summary-item"><code title={summary.commit}>{shortHash(summary.commit)}</code><span>{summary.lineCount}行（{summary.percent.toFixed(1)}%）</span><button type="button" className="table-action" disabled={commitFilter === summary.commit} onClick={() => setCommitFilter(summary.commit)} aria-label={`${shortHash(summary.commit)} の行だけに絞り込む`}>{commitFilter === summary.commit ? "選択中" : "このコミットだけ表示"}</button></li>)}</ul></section>}
        {filterError ? <p className="blame-empty" role="status">絞り込み条件が正しくなると、取得済み行を表示します。</p> : filtered.length === 0 ? <p className="blame-empty" role="status">{lines.length === 0 ? "一致する行はありません。" : "条件に一致する取得済み行はありません。"}</p> : <div className="blame-table-wrap" role="region" aria-label="行ごとの変更元" tabIndex={0}><table className="blame-table"><thead><tr><th>行</th><th>変更元</th><th>作成者</th><th>日時</th><th>内容</th><th>パス</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{filtered.map((line) => <tr key={`${line.final_line}:${line.commit}`}><td className="blame-line"><strong>{line.final_line}</strong><small>原文 {line.original_line}</small></td><td className="blame-commit-cell"><code title={line.commit}>{shortHash(line.commit)}</code><span title={line.summary}>{line.summary || "件名未取得"}</span><CopyButton value={line.commit} label={`${shortHash(line.commit)} をコピー`} /></td><td><span>{line.author || "作成者未取得"}</span><small>{line.email || "メール未取得"}</small></td><td><time>{blameTime(line.time)}</time></td><td className="blame-content"><code>{line.content}</code></td><td className="blame-path" title={line.path}>{line.path}</td><td><button type="button" className="table-action" onClick={() => setSelectedHash(line.commit)} aria-label={`${shortHash(line.commit)} のコミット詳細を表示`}>コミットを表示</button></td></tr>)}</tbody></table></div>}
        {selectedHash && <CommitDetailPane key={selectedHash} path={path} hash={selectedHash} visibleCommitHashes={visibleCommitHashes} onSelectHash={setSelectedHash} />}
      </>}
      {state === "idle" && <p className="blame-empty" role="status">対象を入力して行帰属を取得してください。</p>}
    </div>
  </details>;
}

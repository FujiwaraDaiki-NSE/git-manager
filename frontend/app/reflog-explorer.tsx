"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CommitFiles from "./commit-files";
import CopyButton from "./copy-button";
import PatchView from "./patch-view";
import {
  filterReflog,
  isReflogCommitHash,
  isValidReflogRef,
  reflogCommand,
  reflogCsv,
  reflogDateRangeError,
  reflogHashList,
  reflogRequestQuery,
} from "./reflog-explorer-tools.mjs";
import type { CommitDetail } from "./types";
import "./reflog-explorer.css";

type ReflogRecord = {
  hash: string;
  selector: string | null;
  message: string | null;
  action?: string | null;
  actor: string | null;
  date: string | null;
};

type ReflogInventory = {
  ref: string;
  records: ReflogRecord[];
  truncated: boolean;
  available: boolean;
  command?: string;
};

type LoadState = "idle" | "loading" | "ready" | "error";

function exactDate(value: string | null) {
  if (!value) return "日時未取得";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "日時未取得" : date.toLocaleString("ja-JP");
}

function shortHash(value: string) {
  return value.slice(0, 10);
}

async function responseError(response: Response) {
  try {
    const body = await response.json() as { detail?: unknown };
    if (typeof body.detail === "string" && body.detail) return body.detail;
  } catch {
    // A proxy may return non-JSON text.  The status remains useful below.
  }
  if (response.status === 404) return "選択した参照またはリポジトリが見つかりません。参照を確認してください。";
  if (response.status === 422) return "HEAD または完全な refs/heads/*・refs/remotes/*・refs/stash を指定してください。";
  return `HTTP ${response.status}`;
}

function messageValue(record: ReflogRecord) {
  return record.message ?? record.action ?? "操作メッセージ未取得";
}

function CommitDetailPane({ path, hash }: { path: string; hash: string }) {
  const [state, setState] = useState<LoadState>("loading");
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState("loading");
    setDetail(null);
    setError(null);
    void fetch(`/api/repo/commit?${new URLSearchParams({ path, hash }).toString()}`, {
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
      setError(caught instanceof Error ? caught.message : "コミット詳細を取得できませんでした。");
      setState("error");
    });
    return () => controller.abort();
  }, [hash, path, retry]);

  return (
    <section className="reflog-explorer-commit" aria-labelledby="reflog-explorer-commit-title">
      <div className="reflog-explorer-commit-heading">
        <div>
          <h4 id="reflog-explorer-commit-title">移動後のコミット詳細</h4>
          <code>{hash}</code>
        </div>
        <CopyButton value={hash} label="コミットIDをコピー" />
      </div>
      {state === "loading" && <p className="reflog-explorer-state" role="status">コミット詳細を取得中…</p>}
      {state === "error" && (
        <p className="reflog-explorer-error" role="alert">
          コミット詳細を取得できませんでした。{error && <span>（{error}）</span>}
          <button className="subtle-button" type="button" onClick={() => setRetry((value) => value + 1)}>再取得</button>
        </p>
      )}
      {state === "ready" && detail && (
        <>
          <div className="reflog-explorer-commit-meta">
            <strong>{detail.subject || "件名未取得"}</strong>
            <span>{detail.author || "author 未取得"}</span>
            <time dateTime={detail.date || undefined}>{exactDate(detail.date)}</time>
          </div>
          <CommitFiles key={detail.hash} files={detail.files} downloadName={`${detail.hash}-files.tsv`} />
          <PatchView key={detail.hash} patch={detail.patch} />
          {detail.patch_truncated && <p className="reflog-explorer-note" role="status">差分が大きいため一部を省略しています。</p>}
        </>
      )}
    </section>
  );
}

export type ReflogExplorerProps = { path: string };

export default function ReflogExplorer({ path }: ReflogExplorerProps) {
  const [ref, setRef] = useState("");
  const [query, setQuery] = useState("");
  const [startDate, setStartDate] = useState<string | null>(null);
  const [endDate, setEndDate] = useState<string | null>(null);
  const [inventory, setInventory] = useState<ReflogInventory | null>(null);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState("");
  const controllerRef = useRef<AbortController | null>(null);
  const requestKeyRef = useRef<string | null>(null);
  const requestSequenceRef = useRef(0);

  // A path change starts a new explicit investigation.  In particular, do
  // not carry HEAD or any other ref from the previous checkout as a fallback.
  useEffect(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    requestKeyRef.current = null;
    requestSequenceRef.current += 1;
    setRef("");
    setQuery("");
    setStartDate(null);
    setEndDate(null);
    setInventory(null);
    setSelectedHash(null);
    setState("idle");
    setError(null);
    setExportStatus("");
  }, [path]);

  const dateRangeError = useMemo(() => reflogDateRangeError(startDate, endDate), [endDate, startDate]);
  const filtered = useMemo(
    () => filterReflog(inventory?.records ?? [], query, startDate, endDate) as ReflogRecord[],
    [endDate, inventory?.records, query, startDate],
  );
  const selectedRecord = useMemo(
    () => selectedHash === null ? null : inventory?.records.find((record) => record.hash === selectedHash) ?? null,
    [inventory?.records, selectedHash],
  );

  const handleRefChange = useCallback((value: string) => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    requestKeyRef.current = null;
    requestSequenceRef.current += 1;
    setRef(value);
    setInventory(null);
    setSelectedHash(null);
    setExportStatus("");
    setState("idle");
    setError(null);
  }, []);

  const run = useCallback(async () => {
    // A new explicit run supersedes any prior request, including an invalid
    // submission.  Clear the key before validation so an old response cannot
    // be accepted while the user is correcting the ref input.
    controllerRef.current?.abort();
    controllerRef.current = null;
    requestKeyRef.current = null;
    requestSequenceRef.current += 1;
    if (!isValidReflogRef(ref)) {
      setInventory(null);
      setSelectedHash(null);
      setExportStatus("");
      setError("HEAD または完全な refs/heads/*・refs/remotes/*・refs/stash を明示的に指定してください。");
      setState("error");
      return;
    }
    const requestKey = JSON.stringify([path, ref, requestSequenceRef.current]);
    requestKeyRef.current = requestKey;
    const controller = new AbortController();
    controllerRef.current = controller;
    setState("loading");
    setError(null);
    setInventory(null);
    setSelectedHash(null);
    setExportStatus("");
    try {
      const response = await fetch(`/api/repo/reflog?${reflogRequestQuery(path, ref)}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await responseError(response));
      const value = await response.json() as ReflogInventory;
      const validResponse = value.ref === ref
        && typeof value.available === "boolean"
        && typeof value.truncated === "boolean"
        && Array.isArray(value.records);
      if (requestKeyRef.current !== requestKey || !validResponse) {
        if (requestKeyRef.current === requestKey && !validResponse) throw new Error("reflog一覧の形式が不正です。");
        return;
      }
      setInventory(value);
      setState("ready");
    } catch (caught: unknown) {
      if (controller.signal.aborted || requestKeyRef.current !== requestKey) return;
      setError(caught instanceof Error ? caught.message : "reflog一覧を取得できませんでした。");
      setState("error");
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    }
  }, [path, ref]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const exportCsv = useCallback(() => {
    if (filtered.length === 0) return;
    try {
      const url = URL.createObjectURL(new Blob([reflogCsv(filtered)], { type: "text/csv;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "gitdash-reflog.csv";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportStatus(`${filtered.length}件のCSV保存を開始しました。`);
    } catch {
      setExportStatus("CSVを保存できませんでした。");
    }
  }, [filtered]);

  const command = inventory ? reflogCommand(path, inventory.ref) : null;
  const canRun = isValidReflogRef(ref) && state !== "loading";

  return (
    <details className="reflog-explorer">
      <summary>参照の移動履歴を調べる <span>reflog・検索・CSV・コミット詳細</span></summary>
      <div className="reflog-explorer-body">
        <div className="reflog-explorer-heading">
          <div>
            <h3>選択した参照の移動を読み取り専用で確認</h3>
            <p>HEAD または完全な ref 名を選んでから調査します。取得済みの最大1,000件だけが検索対象です。</p>
          </div>
          {inventory?.truncated && <span className="reflog-explorer-truncated" role="status">古い履歴は1,000件の上限により省略されています。</span>}
        </div>

        <div className="reflog-explorer-run" role="group" aria-label="reflogの取得対象">
          <label>
            <span>調べる ref（必須）</span>
            <input
              type="text"
              list="reflog-ref-suggestions"
              value={ref}
              onChange={(event) => handleRefChange(event.target.value)}
              placeholder="HEAD または refs/heads/main"
              aria-label="reflogを調べるref"
              aria-invalid={ref !== "" && !isValidReflogRef(ref)}
            />
            <datalist id="reflog-ref-suggestions"><option value="HEAD" /><option value="refs/stash" /></datalist>
          </label>
          <button type="button" className="reflog-explorer-run-button" onClick={() => void run()} disabled={!canRun}>
            {state === "loading" ? "取得中…" : "このrefを調査"}
          </button>
        </div>

        {state === "idle" && !inventory && <p className="reflog-explorer-empty" role="status">refを明示して「このrefを調査」を押すまで、Gitには問い合わせません。</p>}
        {state === "loading" && <p className="reflog-explorer-state" role="status">reflogを読み込んでいます…</p>}
        {error && <p className="reflog-explorer-error" role="alert">{error}<button className="subtle-button" type="button" onClick={() => void run()} disabled={!canRun}>再試行</button></p>}

        {inventory && (
          <>
            <div className="reflog-explorer-tools">
              <label className="reflog-explorer-search"><span>操作・メッセージ・hash・actorを検索</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="空白でAND検索" aria-label="reflogを検索" /></label>
              <label><span>開始日（ローカル）</span><input type="date" value={startDate ?? ""} onChange={(event) => setStartDate(event.target.value === "" ? null : event.target.value)} aria-invalid={Boolean(dateRangeError)} /></label>
              <label><span>終了日（ローカル）</span><input type="date" value={endDate ?? ""} onChange={(event) => setEndDate(event.target.value === "" ? null : event.target.value)} aria-invalid={Boolean(dateRangeError)} /></label>
              <button className="subtle-button" type="button" onClick={() => { setQuery(""); setStartDate(null); setEndDate(null); setExportStatus(""); }} disabled={!query && startDate === null && endDate === null}>条件をリセット</button>
              <button className="subtle-button" type="button" onClick={exportCsv} disabled={filtered.length === 0}>一致する履歴をCSV保存</button>
              {filtered.length > 0 && <CopyButton value={reflogHashList(filtered)} label="一致するコミットのハッシュをコピー" />}
              {command && <CopyButton value={command} label="reflog確認コマンドをコピー" />}
            </div>
            {dateRangeError && <p className="reflog-explorer-date-error" role="alert">{dateRangeError}</p>}
            <div className="reflog-explorer-coverage" role="status">
              <span>{filtered.length} / {inventory.records.length} 件</span>
              <span>{inventory.ref}</span>
              {exportStatus && <span>{exportStatus}</span>}
            </div>
            {inventory.records.length === 0 ? (
              <p className="reflog-explorer-empty" role="status">{inventory.available ? "保存された移動記録は0件です。" : "この参照の移動履歴は保存されていません（参照が存在しない場合もあります）。"}</p>
            ) : filtered.length === 0 ? (
              <p className="reflog-explorer-empty" role="status">取得済みの reflog に一致する履歴はありません。</p>
            ) : (
              <div className="reflog-explorer-table-wrap" role="region" aria-label={`${inventory.ref} のreflog`} tabIndex={0}>
                <table className="reflog-explorer-table">
                  <thead><tr><th scope="col">日時</th><th scope="col">操作・メッセージ</th><th scope="col">actor</th><th scope="col">移動後のコミット</th><th scope="col"><span className="sr-only">操作</span></th></tr></thead>
                  <tbody>{filtered.map((record, index) => {
                    const selected = record.hash === selectedHash;
                    return <tr key={`${record.selector ?? ""}:${record.hash}:${index}`} className={selected ? "is-selected" : undefined}>
                      <td><time dateTime={record.date ?? undefined}>{exactDate(record.date)}</time></td>
                      <td className="reflog-explorer-message"><strong>{record.action ?? ""}</strong>{record.action && messageValue(record) !== record.action ? <span>{messageValue(record)}</span> : !record.action && <span>{messageValue(record)}</span>}</td>
                      <td>{record.actor || "actor未取得"}</td>
                      <td className="reflog-explorer-hash"><code title={record.hash}>{shortHash(record.hash)}</code><CopyButton value={record.hash} label="コミットIDをコピー" /></td>
                      <td><button className="table-action" type="button" onClick={() => setSelectedHash(isReflogCommitHash(record.hash) ? record.hash : null)} disabled={!isReflogCommitHash(record.hash)}>{selected ? "表示中" : "コミットを表示"}</button></td>
                    </tr>;
                  })}</tbody>
                </table>
              </div>
            )}
            {selectedRecord && isReflogCommitHash(selectedRecord.hash) && <CommitDetailPane key={`${path}:${selectedRecord.hash}`} path={path} hash={selectedRecord.hash} />}
          </>
        )}
      </div>
    </details>
  );
}


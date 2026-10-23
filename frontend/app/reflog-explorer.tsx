"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CommitFiles from "./commit-files";
import CopyButton from "./copy-button";
import PatchView from "./patch-view";
import {
  isReflogCommitHash,
  isValidReflogRef,
  reflogCommand,
  reflogCsv,
  reflogDateRangeError,
  reflogHashList,
  reflogRequestQuery,
} from "./reflog-explorer-tools.mjs";
import {
  UNKNOWN_ACTOR_FILTER,
  UNKNOWN_OPERATION_KIND_FILTER,
  adjacentReflogRecords,
  encodeReflogActor,
  filterReflogInvestigation,
  hasUnknownReflogActor,
  hasUnknownReflogOperation,
  latestReflogOperations,
  reflogActors,
  reflogFilteredJson,
  reflogInvestigationMarkdown,
  reflogOperationKind,
  reflogOperationKinds,
  reflogRecordIdentity,
  sortReflog,
} from "./reflog-investigation-tools.mjs";
import type { CommitDetail } from "./types";
import "./reflog-explorer.css";

type ReflogRecord = {
  recordId: string;
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
type ReflogOrder = "git" | "newest" | "oldest";
type ReflogView = "table" | "cards";

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
  const [actorFilter, setActorFilter] = useState<string | null>(null);
  const [operationFilter, setOperationFilter] = useState<string | null>(null);
  const [startDate, setStartDate] = useState<string | null>(null);
  const [endDate, setEndDate] = useState<string | null>(null);
  const [order, setOrder] = useState<ReflogOrder>("git");
  const [latestOnly, setLatestOnly] = useState(false);
  const [view, setView] = useState<ReflogView>("table");
  const [inventory, setInventory] = useState<ReflogInventory | null>(null);
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
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
    setActorFilter(null);
    setOperationFilter(null);
    setStartDate(null);
    setEndDate(null);
    setOrder("git");
    setLatestOnly(false);
    setView("table");
    setInventory(null);
    setSelectedRecordId(null);
    setState("idle");
    setError(null);
    setExportStatus("");
  }, [path]);

  const dateRangeError = useMemo(() => reflogDateRangeError(startDate, endDate), [endDate, startDate]);
  const filtered = useMemo(
    () => filterReflogInvestigation(inventory?.records ?? [], {
      query,
      actorFilter,
      operationFilter,
      startDate,
      endDate,
    }) as ReflogRecord[],
    [actorFilter, endDate, inventory?.records, operationFilter, query, startDate],
  );
  // Deduplication intentionally runs while the filtered rows still retain
  // Git's newest-first inventory order.  The selected semantic order is a
  // presentation concern applied only afterward.
  const reduced = useMemo(
    () => latestOnly ? latestReflogOperations(filtered) as ReflogRecord[] : [...filtered],
    [filtered, latestOnly],
  );
  const visible = useMemo(() => sortReflog(reduced, order) as ReflogRecord[], [order, reduced]);
  const selectedRecord = useMemo(
    () => selectedRecordId === null ? null : inventory?.records.find((record) => record.recordId === selectedRecordId) ?? null,
    [inventory?.records, selectedRecordId],
  );
  const navigation = useMemo(() => adjacentReflogRecords(visible, selectedRecordId), [selectedRecordId, visible]);
  const actors = useMemo(() => reflogActors(inventory?.records ?? []), [inventory?.records]);
  const operationKinds = useMemo(() => reflogOperationKinds(inventory?.records ?? []), [inventory?.records]);

  const handleRefChange = useCallback((value: string) => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    requestKeyRef.current = null;
    requestSequenceRef.current += 1;
    setRef(value);
    setActorFilter(null);
    setOperationFilter(null);
    setOrder("git");
    setLatestOnly(false);
    setInventory(null);
    setSelectedRecordId(null);
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
      setSelectedRecordId(null);
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
    setSelectedRecordId(null);
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
      setInventory({ ...value, records: value.records.map((record, index) => ({ ...record, recordId: reflogRecordIdentity(record, index) })) });
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
    if (visible.length === 0) return;
    try {
      const url = URL.createObjectURL(new Blob([reflogCsv(visible)], { type: "text/csv;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "gitdash-reflog.csv";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportStatus(`${visible.length}件のCSV保存を開始しました。`);
    } catch {
      setExportStatus("CSVを保存できませんでした。");
    }
  }, [visible]);

  const exportJson = useCallback(() => {
    if (!inventory || visible.length === 0) return;
    try {
      const json = reflogFilteredJson({
        path,
        ref: inventory.ref,
        records: visible,
        available: inventory.available,
        truncated: inventory.truncated,
      });
      const url = URL.createObjectURL(new Blob([json], { type: "application/json;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "gitdash-reflog.json";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportStatus(`${visible.length}件のJSON保存を開始しました。`);
    } catch {
      setExportStatus("JSONを保存できませんでした。");
    }
  }, [inventory, path, visible]);

  const command = inventory ? reflogCommand(path, inventory.ref) : null;
  const canRun = isValidReflogRef(ref) && state !== "loading";

  return (
    <details className="reflog-explorer">
      <summary>参照の移動履歴を調べる <span>reflog・絞り込み・並び替え・調査レポート</span></summary>
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
            <div className="reflog-explorer-tools" role="group" aria-label="reflogの絞り込みと表示操作">
              <label className="reflog-explorer-search"><span>操作・メッセージ・hash・actorを検索</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="空白でAND検索" aria-label="reflogを検索" /></label>
              <label><span>actor（完全一致）</span><select aria-label="reflogのactorで絞り込み" value={actorFilter ?? ""} onChange={(event) => setActorFilter(event.target.value || null)}><option value="">すべて</option>{actors.map((actor) => <option key={actor} value={encodeReflogActor(actor)}>{actor}</option>)}{hasUnknownReflogActor(inventory.records) && <option value={UNKNOWN_ACTOR_FILTER}>actor未取得</option>}</select></label>
              <label><span>操作種別（prefix）</span><select aria-label="reflogの操作種別で絞り込み" value={operationFilter ?? ""} onChange={(event) => setOperationFilter(event.target.value || null)}><option value="">すべて</option>{operationKinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}{hasUnknownReflogOperation(inventory.records) && <option value={UNKNOWN_OPERATION_KIND_FILTER}>操作種別未取得</option>}</select></label>
              <label><span>開始日（ローカル）</span><input type="date" value={startDate ?? ""} onChange={(event) => setStartDate(event.target.value === "" ? null : event.target.value)} aria-invalid={Boolean(dateRangeError)} /></label>
              <label><span>終了日（ローカル）</span><input type="date" value={endDate ?? ""} onChange={(event) => setEndDate(event.target.value === "" ? null : event.target.value)} aria-invalid={Boolean(dateRangeError)} /></label>
              <label><span>並び順</span><select aria-label="reflogの並び順" value={order} onChange={(event) => setOrder(event.target.value as ReflogOrder)}><option value="git">Gitの履歴順</option><option value="newest">日時が新しい順</option><option value="oldest">日時が古い順</option></select></label>
              <div className="reflog-explorer-view-toggle" role="group" aria-label="reflogの表示形式"><span>表示形式</span><button type="button" className="subtle-button" aria-pressed={view === "table"} onClick={() => setView("table")}>表</button><button type="button" className="subtle-button" aria-pressed={view === "cards"} onClick={() => setView("cards")}>カード</button></div>
              <label className="reflog-explorer-latest-toggle"><input type="checkbox" checked={latestOnly} onChange={(event) => setLatestOnly(event.target.checked)} /> <span>コミットごとに最新の操作1件</span></label>
              <button className="subtle-button" type="button" onClick={() => { setQuery(""); setActorFilter(null); setOperationFilter(null); setStartDate(null); setEndDate(null); setOrder("git"); setLatestOnly(false); setExportStatus(""); }} disabled={!query && actorFilter === null && operationFilter === null && startDate === null && endDate === null && order === "git" && !latestOnly}>条件をリセット</button>
              <button className="subtle-button" type="button" onClick={exportCsv} disabled={visible.length === 0}>表示中をCSV保存</button>
              <button className="subtle-button" type="button" onClick={exportJson} disabled={visible.length === 0}>表示中をJSON保存</button>
              {visible.length > 0 && <CopyButton value={reflogHashList(visible)} label="表示中コミットのハッシュをコピー" />}
              {command && <CopyButton value={command} label="reflog確認コマンドをコピー" />}
            </div>
            {dateRangeError && <p className="reflog-explorer-date-error" role="alert">{dateRangeError}</p>}
            <div className="reflog-explorer-coverage" role="status">
              <span>表示 {visible.length} / 一致 {filtered.length} / 取得済み {inventory.records.length}件</span>
              <span>{inventory.ref}</span>
              {latestOnly && <span>コミットごとに最新の操作のみ</span>}
              {navigation.index >= 0 && <span>選択 {navigation.index + 1} / {navigation.count}</span>}
              {selectedRecordId !== null && navigation.index < 0 && <span>選択中の操作は現在の条件外</span>}
              {exportStatus && <span>{exportStatus}</span>}
            </div>
            {inventory.records.length === 0 ? (
              <p className="reflog-explorer-empty" role="status">{inventory.available ? "保存された移動記録は0件です。" : "この参照の移動履歴は保存されていません（参照が存在しない場合もあります）。"}</p>
            ) : visible.length === 0 ? (
              <p className="reflog-explorer-empty" role="status">取得済みの reflog に一致する履歴はありません。</p>
            ) : view === "table" ? (
              <div className="reflog-explorer-table-wrap" role="region" aria-label={`${inventory.ref} のreflog`} tabIndex={0}>
                <table className="reflog-explorer-table">
                  <thead><tr><th scope="col">日時</th><th scope="col">操作・メッセージ</th><th scope="col">actor</th><th scope="col">移動後のコミット</th><th scope="col"><span className="sr-only">操作</span></th></tr></thead>
                  <tbody>{visible.map((record) => {
                    const selected = record.recordId === selectedRecordId;
                    const kind = reflogOperationKind(record);
                    return <tr key={record.recordId} className={selected ? "is-selected" : undefined}>
                      <td><time dateTime={record.date ?? undefined}>{exactDate(record.date)}</time></td>
                      <td className="reflog-explorer-message"><strong>{kind ?? "操作種別未取得"}</strong><span>{messageValue(record)}</span></td>
                      <td>{record.actor || "actor未取得"}</td>
                      <td className="reflog-explorer-hash"><code title={record.hash}>{shortHash(record.hash)}</code><CopyButton value={record.hash} label="コミットIDをコピー" /></td>
                      <td><button className="table-action" type="button" onClick={() => setSelectedRecordId(record.recordId)}>{selected ? "表示中" : "操作を表示"}</button></td>
                    </tr>;
                  })}</tbody>
                </table>
              </div>
            ) : (
              <div className="reflog-explorer-cards" role="list" aria-label={`${inventory.ref} のreflogカード`}>
                {visible.map((record) => {
                  const selected = record.recordId === selectedRecordId;
                  const kind = reflogOperationKind(record);
                  return <article className={`reflog-explorer-card${selected ? " is-selected" : ""}`} key={record.recordId} role="listitem">
                    <div className="reflog-explorer-card-heading"><strong>{kind ?? "操作種別未取得"}</strong><time dateTime={record.date ?? undefined}>{exactDate(record.date)}</time></div>
                    <p className="reflog-explorer-card-message">{messageValue(record)}</p>
                    <dl><div><dt>actor</dt><dd>{record.actor || "actor未取得"}</dd></div><div><dt>hash</dt><dd><code title={record.hash}>{shortHash(record.hash)}</code></dd></div><div><dt>selector</dt><dd><code>{record.selector || "selector未取得"}</code></dd></div></dl>
                    <div className="reflog-explorer-card-actions"><CopyButton value={record.hash} label="コミットIDをコピー" /><button className="table-action" type="button" onClick={() => setSelectedRecordId(record.recordId)}>{selected ? "表示中" : "操作を表示"}</button></div>
                  </article>;
                })}
              </div>
            )}
            <div className="reflog-explorer-navigation" role="group" aria-label="表示中reflogの移動">
              <button type="button" className="subtle-button" onClick={() => navigation.previous && setSelectedRecordId(navigation.previous.recordId)} disabled={navigation.previous === null}>← 前の操作</button>
              <button type="button" className="subtle-button" onClick={() => navigation.next && setSelectedRecordId(navigation.next.recordId)} disabled={navigation.next === null}>次の操作 →</button>
            </div>
            {selectedRecord && (
              <section className="reflog-explorer-operation" aria-labelledby="reflog-explorer-operation-title">
                <div className="reflog-explorer-operation-heading">
                  <div><h4 id="reflog-explorer-operation-title">選択した操作</h4><p><code>{selectedRecord.selector || "selector未取得"}</code></p></div>
                  <div className="reflog-explorer-operation-actions"><CopyButton value={reflogInvestigationMarkdown(selectedRecord, path, inventory.ref)} label="選択した操作のMarkdownレポートをコピー" />{isReflogCommitHash(selectedRecord.hash) && <CopyButton value={selectedRecord.hash} label="コミットIDをコピー" />}</div>
                </div>
                <dl className="reflog-explorer-operation-meta"><div><dt>操作種別</dt><dd>{reflogOperationKind(selectedRecord) ?? "操作種別未取得"}</dd></div><div><dt>日時</dt><dd>{exactDate(selectedRecord.date)}</dd></div><div><dt>actor</dt><dd>{selectedRecord.actor || "actor未取得"}</dd></div><div><dt>message</dt><dd>{messageValue(selectedRecord)}</dd></div></dl>
              </section>
            )}
            {selectedRecord && isReflogCommitHash(selectedRecord.hash) && <CommitDetailPane key={`${path}:${selectedRecord.recordId}:${selectedRecord.hash}`} path={path} hash={selectedRecord.hash} />}
          </>
        )}
      </div>
    </details>
  );
}


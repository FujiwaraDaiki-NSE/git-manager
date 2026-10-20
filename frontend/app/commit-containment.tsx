"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CommitFiles from "./commit-files";
import CopyButton from "./copy-button";
import PatchView from "./patch-view";
import type { CommitDetail } from "./types";
import {
  buildContainmentCompareUrl,
  buildContainmentCsv,
  containmentRefDisplayName,
  containmentRequestQuery,
  containmentSnapshotKey,
  containmentTypeLabel,
  CONTAINMENT_TYPES,
  defaultCommitContainment,
  filterContainmentRefs,
  isContainmentHash,
  isValidContainmentRevision,
} from "./commit-containment-tools.mjs";
import "./commit-containment.css";

type ContainmentType = "local" | "remote" | "tag";
type ContainmentRef = {
  ref: string;
  object_hash: string;
  peeled_commit: string;
  type: ContainmentType;
};
type ContainmentInventory = {
  revision: string;
  pinned_hash: string;
  refs: ContainmentRef[];
  observed_at: number;
  truncated: boolean;
  record_limit: number;
  byte_limit: number;
  command?: string;
};
type LoadState = "idle" | "loading" | "ready" | "error";

const FILTER_TYPES = ["all", "local", "remote", "tag"] as const;
type FilterType = typeof FILTER_TYPES[number];

function isValidRef(value: unknown): value is ContainmentRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Partial<ContainmentRef>;
  return typeof item.ref === "string"
    && isContainmentHash(item.object_hash)
    && isContainmentHash(item.peeled_commit)
    && (item.type === "local" || item.type === "remote" || item.type === "tag");
}

function normalizeInventory(value: unknown): ContainmentInventory | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const item = value as Partial<ContainmentInventory>;
  if (typeof item.revision !== "string" || typeof item.pinned_hash !== "string" || !isContainmentHash(item.pinned_hash)) return null;
  if (!Array.isArray(item.refs) || !item.refs.every(isValidRef)) return null;
  if (typeof item.observed_at !== "number" || !Number.isFinite(item.observed_at)) return null;
  if (typeof item.truncated !== "boolean") return null;
  if (typeof item.record_limit !== "number" || !Number.isInteger(item.record_limit) || item.record_limit < 1) return null;
  if (typeof item.byte_limit !== "number" || !Number.isInteger(item.byte_limit) || item.byte_limit < 1) return null;
  return item as ContainmentInventory;
}

async function responseError(response: Response) {
  try {
    const body = await response.json() as { detail?: unknown };
    if (typeof body.detail === "string" && body.detail.length > 0) return body.detail;
  } catch {
    // Keep a stable message when a proxy returns non-JSON text.
  }
  if (response.status === 422) return "HEAD、完全なコミットハッシュ、またはGit refを明示してください。";
  if (response.status >= 500) return "Gitの状態を確認できませんでした。リポジトリを確認して再試行してください。";
  return `HTTP ${response.status}`;
}

function exactDate(value: number) {
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? "観測日時未取得" : date.toLocaleString("ja-JP");
}

function dateTimeValue(value: number) {
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function shortHash(value: string) {
  return value.slice(0, 12);
}

function downloadCsv(content: string, name: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function CommitDetailPane({ path, snapshotKey, item }: { path: string; snapshotKey: string; item: ContainmentRef }) {
  const [state, setState] = useState<LoadState>("loading");
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const requestKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const requestKey = `${snapshotKey}\u0000${item.ref}\u0000${item.peeled_commit}\u0000${retry}`;
    requestKeyRef.current = requestKey;
    setState("loading");
    setDetail(null);
    setError(null);
    void fetch(`/api/repo/commit?${new URLSearchParams({ path, hash: item.peeled_commit }).toString()}`, {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(await responseError(response));
      return await response.json() as CommitDetail;
    }).then((value) => {
      if (controller.signal.aborted || requestKeyRef.current !== requestKey) return;
      if (!value || !isContainmentHash(value.hash) || value.hash.toLowerCase() !== item.peeled_commit.toLowerCase()) {
        throw new Error("選択した参照の固定コミットと異なる詳細が返されました。");
      }
      setDetail(value);
      setState("ready");
    }).catch((caught: unknown) => {
      if (controller.signal.aborted || requestKeyRef.current !== requestKey) return;
      setError(caught instanceof Error ? caught.message : "コミット詳細を取得できませんでした。");
      setState("error");
    });
    return () => {
      controller.abort();
      if (requestKeyRef.current === requestKey) requestKeyRef.current = null;
    };
  }, [item.peeled_commit, item.ref, path, retry, snapshotKey]);

  return (
    <section className="commit-containment-detail" aria-labelledby="commit-containment-detail-title">
      <div className="commit-containment-detail-heading">
        <div>
          <h4 id="commit-containment-detail-title">選択した参照の固定先コミット</h4>
          <p><code>{item.ref}</code> · <code>{item.peeled_commit}</code></p>
        </div>
        <CopyButton value={item.peeled_commit} label="固定先コミットIDをコピー" />
      </div>
      {state === "loading" && <p className="commit-containment-state" role="status">コミット詳細を取得中…</p>}
      {state === "error" && (
        <p className="commit-containment-error" role="alert">
          コミット詳細を取得できませんでした。{error && <span>（{error}）</span>}
          <button className="subtle-button" type="button" onClick={() => setRetry((value) => value + 1)}>再取得</button>
        </p>
      )}
      {state === "ready" && detail && (
        <>
          <div className="commit-containment-detail-meta">
            <strong>{detail.subject || "件名未取得"}</strong>
            <span>{detail.author || "author 未取得"}</span>
            <time dateTime={detail.date || undefined}>{detail.date || "日時未取得"}</time>
          </div>
          <CommitFiles key={detail.hash} files={detail.files} downloadName={`${detail.hash}-files.tsv`} />
          <PatchView key={detail.hash} patch={detail.patch} />
          {detail.patch_truncated && <p className="commit-containment-note" role="status">差分が大きいため一部を省略しています。</p>}
        </>
      )}
    </section>
  );
}

export type CommitContainmentProps = { path: string };

export default function CommitContainment({ path }: CommitContainmentProps) {
  const defaults = useMemo(() => defaultCommitContainment({ path }), [path]);
  const [revision, setRevision] = useState(defaults.revision);
  const [query, setQuery] = useState(defaults.query);
  const [type, setType] = useState<FilterType>(defaults.type as FilterType);
  const [inventory, setInventory] = useState<ContainmentInventory | null>(null);
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState("");
  const controllerRef = useRef<AbortController | null>(null);
  const requestKeyRef = useRef<string | null>(null);
  const requestSequenceRef = useRef(0);

  useEffect(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    requestKeyRef.current = null;
    requestSequenceRef.current += 1;
    setRevision(defaults.revision);
    setQuery(defaults.query);
    setType(defaults.type as FilterType);
    setInventory(null);
    setSelectedRef(null);
    setState("idle");
    setError(null);
    setExportStatus("");
  }, [defaults]);

  const filtered = useMemo(
    () => filterContainmentRefs(inventory?.refs ?? [], query, type) as ContainmentRef[],
    [inventory?.refs, query, type],
  );
  const selected = useMemo(
    () => selectedRef === null ? null : inventory?.refs.find((item) => item.ref === selectedRef) ?? null,
    [inventory?.refs, selectedRef],
  );
  const snapshotKey = useMemo(
    () => inventory === null ? null : containmentSnapshotKey(path, inventory),
    [inventory, path],
  );

  const invalidate = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    requestKeyRef.current = null;
    requestSequenceRef.current += 1;
  }, []);

  const handleRevisionChange = useCallback((value: string) => {
    invalidate();
    setRevision(value);
    setInventory(null);
    setSelectedRef(null);
    setState("idle");
    setError(null);
    setExportStatus("");
  }, [invalidate]);

  const run = useCallback(async () => {
    invalidate();
    const normalized = revision.trim();
    const sequence = requestSequenceRef.current;
    if (!isValidContainmentRevision(normalized)) {
      setInventory(null);
      setSelectedRef(null);
      setError("HEAD、完全なコミットハッシュ、またはGit refを明示的に指定してください。式やオプションは指定できません。");
      setState("error");
      return;
    }
    const requestKey = JSON.stringify([path, normalized, sequence]);
    requestKeyRef.current = requestKey;
    const controller = new AbortController();
    controllerRef.current = controller;
    setState("loading");
    setError(null);
    setInventory(null);
    setSelectedRef(null);
    setExportStatus("");
    try {
      const response = await fetch(`/api/repo/containment?${containmentRequestQuery(path, normalized)}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await responseError(response));
      const value = normalizeInventory(await response.json());
      if (requestKeyRef.current !== requestKey || value === null) {
        if (requestKeyRef.current === requestKey && value === null) throw new Error("参照一覧の形式が不正です。");
        return;
      }
      if (value.revision !== normalized) throw new Error("取得結果のrevisionが入力値と異なります。");
      setInventory(value);
      setState("ready");
    } catch (caught: unknown) {
      if (controller.signal.aborted || requestKeyRef.current !== requestKey) return;
      setError(caught instanceof Error ? caught.message : "参照一覧を取得できませんでした。");
      setState("error");
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [invalidate, path, revision]);

  useEffect(() => () => {
    controllerRef.current?.abort();
  }, []);

  const exportCsv = useCallback(() => {
    if (inventory === null || filtered.length === 0) return;
    try {
      downloadCsv(buildContainmentCsv(filtered, inventory), "gitdash-commit-containment.csv");
      setExportStatus(`${filtered.length}件の一致する参照のCSV保存を開始しました。`);
    } catch {
      setExportStatus("CSVを保存できませんでした。");
    }
  }, [filtered, inventory]);

  const retry = useCallback(() => {
    if (state === "loading") return;
    void run();
  }, [run, state]);

  const canRun = isValidContainmentRevision(revision.trim()) && state !== "loading";
  const compareHref = (item: ContainmentRef) => {
    if (typeof window === "undefined" || inventory === null) return null;
    try {
      return buildContainmentCompareUrl(window.location.href, inventory.pinned_hash, item.peeled_commit);
    } catch {
      return null;
    }
  };

  return (
    <details className="commit-containment">
      <summary>コミットを含む参照を調べる</summary>
      <div className="commit-containment-body">
        <div className="commit-containment-heading">
          <div>
            <h3>指定したコミットを含む参照を読み取り専用で確認</h3>
            <p>HEAD、完全なコミットハッシュ、またはGit refを明示して調査します。自動fetchや参照の更新は行いません。</p>
          </div>
          {inventory?.truncated && <span className="commit-containment-truncated" role="status">参照が上限に達したため、一覧の一部だけを表示しています。</span>}
        </div>

        <div className="commit-containment-run" role="group" aria-label="コミット含有参照の取得対象">
          <label>
            <span>調べるコミット（必須）</span>
            <input
              type="text"
              value={revision}
              onChange={(event) => handleRevisionChange(event.target.value)}
              placeholder="HEAD または完全なコミットハッシュ"
              aria-label="コミット含有参照を調べるrevision"
              aria-invalid={revision !== "" && !isValidContainmentRevision(revision.trim())}
              autoComplete="off"
            />
          </label>
          <button type="button" className="commit-containment-run-button" onClick={() => void run()} disabled={!canRun}>
            {state === "loading" ? "取得中…" : "このコミットを調査"}
          </button>
        </div>

        {state === "idle" && inventory === null && <p className="commit-containment-empty" role="status">コミットを明示して「このコミットを調査」を押すまで、Gitには問い合わせません。</p>}
        {state === "loading" && <p className="commit-containment-state" role="status">含有する参照を読み込んでいます…</p>}
        {error && <p className="commit-containment-error" role="alert">{error}<button className="subtle-button" type="button" onClick={retry} disabled={!canRun}>再試行</button></p>}

        {inventory && (
          <>
            <div className="commit-containment-tools">
              <label className="commit-containment-search"><span>取得済み参照を検索</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ref名・表示名" aria-label="取得済み参照を検索" /></label>
              <label><span>参照の種類</span><select aria-label="参照の種類で絞り込み" value={type} onChange={(event) => setType(event.target.value as FilterType)}>{CONTAINMENT_TYPES.map((item) => <option key={item} value={item}>{containmentTypeLabel(item)}</option>)}</select></label>
              <button className="subtle-button" type="button" onClick={() => { setQuery(""); setType("all"); setExportStatus(""); }} disabled={!query && type === "all"}>条件をリセット</button>
              <button className="subtle-button" type="button" onClick={exportCsv} disabled={filtered.length === 0}>一致する参照をCSV保存</button>
              <button className="subtle-button" type="button" onClick={() => void run()} disabled={!canRun}>一覧を更新</button>
              {inventory.command && <CopyButton value={inventory.command} label="含有参照の確認コマンドをコピー" />}
            </div>
            <div className="commit-containment-coverage" role="status">
              <span>{filtered.length} / {inventory.refs.length} 件</span>
              <span>固定コミット <code>{inventory.pinned_hash}</code></span>
              <time dateTime={dateTimeValue(inventory.observed_at)}>観測 {exactDate(inventory.observed_at)}</time>
              {exportStatus && <span>{exportStatus}</span>}
            </div>
            {inventory.refs.length === 0 ? (
              <p className="commit-containment-empty" role="status">このコミットを含む参照はありません。</p>
            ) : filtered.length === 0 ? (
              <p className="commit-containment-empty" role="status">取得済みの参照に一致するものはありません。</p>
            ) : (
              <div className="commit-containment-table-wrap" role="region" aria-label="コミットを含む参照一覧" tabIndex={0}>
                <table className="commit-containment-table">
                  <thead><tr><th scope="col">種類</th><th scope="col">参照</th><th scope="col">ref object</th><th scope="col">固定先コミット</th><th scope="col"><span className="sr-only">操作</span></th></tr></thead>
                  <tbody>{filtered.map((item) => {
                    const selectedRow = item.ref === selectedRef;
                    const href = compareHref(item);
                    return <tr key={`${snapshotKey}:${item.ref}:${item.object_hash}`} data-testid="commit-containment-row" data-ref={item.ref} className={selectedRow ? "is-selected" : undefined}>
                      <td><span className={`commit-containment-type commit-containment-type-${item.type}`}>{containmentTypeLabel(item.type)}</span></td>
                      <td className="commit-containment-ref"><strong>{containmentRefDisplayName(item.ref)}</strong><code>{item.ref}</code></td>
                      <td className="commit-containment-hash"><code title={item.object_hash}>{shortHash(item.object_hash)}</code><CopyButton value={item.object_hash} label="ref object hashをコピー" /></td>
                      <td className="commit-containment-hash"><code title={item.peeled_commit}>{shortHash(item.peeled_commit)}</code><CopyButton value={item.peeled_commit} label="固定先コミットIDをコピー" /></td>
                      <td className="commit-containment-actions"><button className="table-action" type="button" onClick={() => setSelectedRef(selectedRow ? null : item.ref)}>{selectedRow ? "表示中" : "コミットを表示"}</button>{href && <a className="table-action" href={href}>比較条件を入力</a>}</td>
                    </tr>;
                  })}</tbody>
                </table>
              </div>
            )}
            {selected && snapshotKey && <CommitDetailPane key={`${snapshotKey}:${selected.ref}:${selected.peeled_commit}`} path={path} snapshotKey={snapshotKey} item={selected} />}
          </>
        )}
      </div>
    </details>
  );
}

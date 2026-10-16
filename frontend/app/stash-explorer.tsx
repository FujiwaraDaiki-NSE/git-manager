"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import CopyButton from "./copy-button";
import CommitFiles from "./commit-files";
import PatchView from "./patch-view";
import type { Numstat } from "./types";
import { searchStashes, stashCommand, stashPartLabel } from "./stash-explorer-tools.mjs";
import "./stash-explorer.css";

type StashSummary = {
  hash: string;
  selector: string;
  subject: string;
  date: string;
};

type StashInventory = {
  stashes: StashSummary[];
  command: string;
};

type StashPart = {
  available: boolean;
  files: Numstat[];
  patch: string;
  patch_truncated: boolean;
  command: string | null;
};

type StashDetail = StashSummary & {
  tracked: StashPart;
  untracked: StashPart;
  command: string;
  untracked_command: string | null;
};

function exactDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "日付未取得" : date.toLocaleString("ja-JP");
}

function shortHash(value: string) {
  return value.slice(0, 10);
}

function responseError(status: number, scope: "inventory" | "detail") {
  if (status === 404 && scope === "detail") return "選択したstashはすでに削除されています。一覧を更新してください。";
  if (status === 404) return "このリポジトリは見つかりません。";
  if (status === 422) return "stashの指定が不正です。";
  return scope === "inventory"
    ? "stash一覧を取得できませんでした。Gitの状態を確認して再試行してください。"
    : "stashの内容を取得できませんでした。Gitの状態を確認して再試行してください。";
}

function StashPartView({
  hash,
  path,
  part,
  kind,
}: {
  hash: string;
  path: string;
  part: StashPart;
  kind: "tracked" | "untracked";
}) {
  const command = stashCommand(path, part.command);
  return (
    <section className="stash-explorer-part" aria-labelledby={`stash-${kind}-title`}>
      <div className="stash-explorer-part-heading">
        <div>
          <h4 id={`stash-${kind}-title`}>{stashPartLabel(kind)}</h4>
          <p>{part.available ? `${part.files.length}ファイルの変更` : "このstashには含まれていません"}</p>
        </div>
        {command && <CopyButton value={command} label={`${stashPartLabel(kind)}の確認コマンドをコピー`} />}
      </div>
      {part.available ? (
        <>
          <CommitFiles key={`${hash}-${kind}-files`} files={part.files} downloadName={`stash-${hash}-${kind}-files.tsv`} />
          <div className="stash-explorer-patch">
            <PatchView key={`${hash}-${kind}-patch`} patch={part.patch} />
            {part.patch_truncated && (
              <p className="stash-explorer-note" role="status">
                差分が大きいため、一部を省略しています。全体は上の確認コマンドをターミナルで実行してください。
              </p>
            )}
          </div>
        </>
      ) : (
        <p className="stash-explorer-empty">未追跡ファイルはありません。trackedの変更だけが保存されています。</p>
      )}
    </section>
  );
}

export default function StashExplorer({ path }: { path: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [inventory, setInventory] = useState<StashInventory | null>(null);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [detail, setDetail] = useState<StashDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const inventoryAttemptRef = useRef<string | null>(null);
  const inventoryControllerRef = useRef<AbortController | null>(null);
  const detailControllerRef = useRef<AbortController | null>(null);

  const loadInventory = useCallback(async (force = false) => {
    if (!force && inventoryAttemptRef.current === path) return;
    inventoryAttemptRef.current = path;
    inventoryControllerRef.current?.abort();
    const controller = new AbortController();
    inventoryControllerRef.current = controller;
    setInventoryLoading(true);
    setInventoryError(null);
    try {
      const params = new URLSearchParams({ path });
      const response = await fetch(`/api/repo/stashes?${params.toString()}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(responseError(response.status, "inventory"));
      const result = await response.json() as StashInventory;
      if (!Array.isArray(result.stashes)) throw new Error("stash一覧の形式が不正です。");
      setInventory(result);
      setSelectedHash((current) => result.stashes.some((stash) => stash.hash === current) ? current : null);
    } catch (caught) {
      if (controller.signal.aborted) return;
      setInventoryError(caught instanceof Error ? caught.message : "stash一覧を取得できませんでした。");
    } finally {
      if (inventoryControllerRef.current === controller) {
        inventoryControllerRef.current = null;
        setInventoryLoading(false);
      }
    }
  }, [path]);

  useEffect(() => {
    inventoryControllerRef.current?.abort();
    detailControllerRef.current?.abort();
    inventoryAttemptRef.current = null;
    setInventory(null);
    setSelectedHash(null);
    setInventoryError(null);
    setDetail(null);
    setDetailError(null);
    setInventoryLoading(false);
    setDetailLoading(false);
  }, [path]);

  useEffect(() => {
    if (open) void loadInventory();
  }, [loadInventory, open]);

  useEffect(() => () => {
    inventoryControllerRef.current?.abort();
    detailControllerRef.current?.abort();
  }, []);

  useEffect(() => {
    detailControllerRef.current?.abort();
    setDetail(null);
    setDetailError(null);
    if (!selectedHash) {
      setDetailLoading(false);
      return undefined;
    }

    const controller = new AbortController();
    detailControllerRef.current = controller;
    setDetailLoading(true);
    void (async () => {
      try {
        const params = new URLSearchParams({ path, hash: selectedHash });
        const response = await fetch(`/api/repo/stash?${params.toString()}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(responseError(response.status, "detail"));
        setDetail(await response.json() as StashDetail);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setDetailError(caught instanceof Error ? caught.message : "stashの内容を取得できませんでした。");
      } finally {
        if (detailControllerRef.current === controller) {
          detailControllerRef.current = null;
          setDetailLoading(false);
        }
      }
    })();
    return () => controller.abort();
  }, [path, selectedHash]);

  const visibleStashes = useMemo(
    () => searchStashes(inventory?.stashes ?? [], query),
    [inventory?.stashes, query],
  );
  const detailCommand = detail ? stashCommand(path, detail.command) : null;

  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    setOpen(event.currentTarget.open);
  };

  return (
    <details className="stash-explorer" onToggle={onToggle}>
      <summary>stashを調べる <span>一覧・検索・差分</span></summary>
      <div className="stash-explorer-body">
        <div className="stash-explorer-heading">
          <div>
            <h3>退避した変更を読み取り専用で確認</h3>
            <p>stashの適用・削除は行わず、保存された変更と未追跡ファイルを分けて表示します。</p>
          </div>
          <button className="stash-explorer-refresh" type="button" onClick={() => void loadInventory(true)} disabled={inventoryLoading}>
            {inventoryLoading ? "読み込み中…" : "一覧を更新"}
          </button>
        </div>

        {inventoryLoading && !inventory && <p className="stash-explorer-state" role="status">stash一覧を読み込んでいます…</p>}
        {inventoryError && (
          <div className="stash-explorer-error" role="alert">
            <span>{inventoryError}</span>
            <button type="button" onClick={() => void loadInventory(true)}>再試行</button>
          </div>
        )}

        {inventory && (
          <>
            <div className="stash-explorer-tools">
              <label>
                <span>subject・hashを検索</span>
                <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="stash subject または hash" aria-label="stashのsubjectまたはhashを検索" />
              </label>
              <span className="stash-explorer-count" role="status">{visibleStashes.length} / {inventory.stashes.length} 件</span>
            </div>

            {inventory.stashes.length === 0 ? (
              <p className="stash-explorer-empty">stashはありません。</p>
            ) : visibleStashes.length === 0 ? (
              <p className="stash-explorer-empty">検索条件に一致するstashはありません。</p>
            ) : (
              <div className="stash-explorer-table-wrap">
                <table className="stash-explorer-table">
                  <thead><tr><th>stash</th><th>保存日時</th><th>hash</th></tr></thead>
                  <tbody>
                    {visibleStashes.map((stash) => (
                      <tr key={stash.hash} className={stash.hash === selectedHash ? "is-selected" : undefined}>
                        <td>
                          <button className="stash-explorer-select" type="button" onClick={() => setSelectedHash(stash.hash)} aria-pressed={stash.hash === selectedHash}>
                            <strong>{stash.subject || "subject未取得"}</strong>
                            <span>{stash.selector}</span>
                          </button>
                        </td>
                        <td><time dateTime={stash.date}>{exactDate(stash.date)}</time></td>
                        <td><code>{shortHash(stash.hash)}</code><CopyButton value={stash.hash} label="stash hashをコピー" /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {detailLoading && <p className="stash-explorer-state" role="status">選択したstashを読み込んでいます…</p>}
        {detailError && <p className="stash-explorer-error" role="alert">{detailError}</p>}
        {detail && (
          <section className="stash-explorer-detail" aria-labelledby="stash-explorer-detail-title">
            <div className="stash-explorer-detail-heading">
              <div>
                <h3 id="stash-explorer-detail-title">{detail.subject || "subject未取得"}</h3>
                <p><span>{detail.selector}</span><time dateTime={detail.date}>{exactDate(detail.date)}</time></p>
              </div>
              <div className="stash-explorer-detail-hash"><code>{detail.hash}</code><CopyButton value={detail.hash} label="stash hashをコピー" /></div>
            </div>
            {detailCommand && (
              <div className="stash-explorer-command">
                <span>trackedを再現</span>
                <code>{detailCommand}</code>
                <CopyButton value={detailCommand} label="stash確認コマンドをコピー" />
              </div>
            )}
            <StashPartView hash={detail.hash} path={path} part={detail.tracked} kind="tracked" />
            <StashPartView hash={detail.hash} path={path} part={detail.untracked} kind="untracked" />
          </section>
        )}
      </div>
    </details>
  );
}


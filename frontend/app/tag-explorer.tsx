"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import CopyButton from "./copy-button";
import type { CommitDetail } from "./types";
import { TAG_SORTS, TAG_TYPES, tagCreatorIdentity, tagsCsv, visibleTags } from "./tag-explorer-tools.mjs";
import "./tag-explorer.css";

type TagType = "lightweight" | "annotated";

type TagSummary = {
  name: string;
  type: TagType;
  hash: string;
  peeled_hash: string | null;
  peeled_type: string | null;
  creator: string | null;
  creator_date: string | null;
};

type TagInventory = {
  tags: TagSummary[];
  command: string;
};

type TagAnnotation = {
  object_hash: string;
  object_type: string;
  tag: string;
  tagger: string | null;
  tagger_date: string | null;
  message: string;
  message_truncated: boolean;
  command: string;
};

type TagDetail = TagSummary & {
  annotation: TagAnnotation | null;
};

type LoadState = "idle" | "loading" | "ready" | "error";

function exactDate(value: string | null) {
  if (!value) return "日付未取得";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "日付未取得" : date.toLocaleString("ja-JP");
}

function shortHash(value: string | null) {
  return value ? value.slice(0, 10) : "—";
}

function typeLabel(type: TagType) {
  return type === "annotated" ? "注釈付き" : "軽量";
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

function TagTarget({ detail, commit, state, error }: { detail: TagDetail; commit: CommitDetail | null; state: LoadState; error: string | null }) {
  if (detail.peeled_type !== "commit") {
    return <p className="tag-explorer-note" role="status">このタグの対象は {detail.peeled_type || "不明なオブジェクト"} です。コミット詳細はこの画面では表示できません。</p>;
  }
  if (state === "loading") return <p className="tag-explorer-state" role="status">対象コミットを読み込んでいます…</p>;
  if (state === "error") return <p className="tag-explorer-error" role="alert">対象コミットを取得できませんでした。{error && <span className="sr-only">{error}</span>}</p>;
  if (!commit) return <p className="tag-explorer-note" role="status">対象コミットの情報はありません。</p>;
  return (
    <div className="tag-explorer-commit">
      <div className="tag-explorer-commit-heading"><strong>{commit.subject || "件名未取得"}</strong><CopyButton value={commit.hash} label="対象コミットのhashをコピー" /></div>
      <div className="tag-explorer-commit-meta"><code>{commit.hash}</code><span>{commit.author || "作成者未取得"}</span><time dateTime={commit.date}>{exactDate(commit.date)}</time></div>
    </div>
  );
}

export default function TagExplorer({ path }: { path: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [type, setType] = useState<"all" | TagType>("all");
  const [sort, setSort] = useState("name");
  const [inventory, setInventory] = useState<TagInventory | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [inventoryState, setInventoryState] = useState<LoadState>("idle");
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [detail, setDetail] = useState<TagDetail | null>(null);
  const [detailState, setDetailState] = useState<LoadState>("idle");
  const [detailError, setDetailError] = useState<string | null>(null);
  const [commit, setCommit] = useState<CommitDetail | null>(null);
  const [commitState, setCommitState] = useState<LoadState>("idle");
  const [commitError, setCommitError] = useState<string | null>(null);
  const [downloadStatus, setDownloadStatus] = useState<"idle" | "success" | "error">("idle");
  const inventoryControllerRef = useRef<AbortController | null>(null);
  const detailControllerRef = useRef<AbortController | null>(null);
  const inventoryAttemptRef = useRef<string | null>(null);

  const loadInventory = useCallback(async (force = false) => {
    if (!force && inventoryAttemptRef.current === path) return;
    inventoryAttemptRef.current = path;
    inventoryControllerRef.current?.abort();
    const controller = new AbortController();
    inventoryControllerRef.current = controller;
    setInventoryState("loading");
    setInventoryError(null);
    try {
      const params = new URLSearchParams({ path });
      const response = await fetch(`/api/repo/tags?${params.toString()}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(await responseError(response));
      const result = await response.json() as TagInventory;
      if (!Array.isArray(result.tags)) throw new Error("タグ一覧の形式が不正です。");
      // A refresh can replace a tag object while keeping its exact name.  Do
      // not leave the old annotation or target commit attached to that name;
      // abort the detail request before clearing the selection so its late
      // response cannot repopulate stale data.
      detailControllerRef.current?.abort();
      detailControllerRef.current = null;
      setInventory(result);
      setSelectedName(null);
      setDetail(null);
      setDetailState("idle");
      setDetailError(null);
      setCommit(null);
      setCommitState("idle");
      setCommitError(null);
      setInventoryState("ready");
    } catch (caught) {
      if (controller.signal.aborted) return;
      setInventoryError(caught instanceof Error ? caught.message : "タグ一覧を取得できませんでした。");
      setInventoryState("error");
    } finally {
      if (inventoryControllerRef.current === controller) inventoryControllerRef.current = null;
    }
  }, [path]);

  useEffect(() => {
    inventoryControllerRef.current?.abort();
    detailControllerRef.current?.abort();
    inventoryAttemptRef.current = null;
    setInventory(null);
    setSelectedName(null);
    setInventoryState("idle");
    setInventoryError(null);
    setDetail(null);
    setDetailState("idle");
    setDetailError(null);
    setCommit(null);
    setCommitState("idle");
    setCommitError(null);
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
    setCommit(null);
    setCommitError(null);
    setCommitState("idle");
    if (!selectedName) {
      setDetailState("idle");
      return undefined;
    }

    const controller = new AbortController();
    detailControllerRef.current = controller;
    setDetailState("loading");
    let loadedDetail = false;
    void (async () => {
      try {
        const params = new URLSearchParams({ path, name: selectedName });
        const response = await fetch(`/api/repo/tag?${params.toString()}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(await responseError(response));
        const result = await response.json() as TagDetail;
        setDetail(result);
        setDetailState("ready");
        loadedDetail = true;
        if (result.peeled_type !== "commit" || !result.peeled_hash) return;
        setCommitState("loading");
        const commitParams = new URLSearchParams({ path, hash: result.peeled_hash });
        const commitResponse = await fetch(`/api/repo/commit?${commitParams.toString()}`, { cache: "no-store", signal: controller.signal });
        if (!commitResponse.ok) throw new Error(await responseError(commitResponse));
        setCommit(await commitResponse.json() as CommitDetail);
        setCommitState("ready");
      } catch (caught) {
        if (controller.signal.aborted) return;
        if (!loadedDetail) {
          setDetailError(caught instanceof Error ? caught.message : "タグの詳細を取得できませんでした。");
          setDetailState("error");
        } else {
          setCommitError(caught instanceof Error ? caught.message : "対象コミットを取得できませんでした。");
          setCommitState("error");
        }
      } finally {
        if (detailControllerRef.current === controller) detailControllerRef.current = null;
      }
    })();
    return () => controller.abort();
  // The detail state is intentionally not a dependency: this effect owns the
  // request and should not restart when its response arrives.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, selectedName]);

  const visible: TagSummary[] = useMemo(
    () => visibleTags(inventory?.tags ?? [], { query, type, sort }) as TagSummary[],
    [inventory?.tags, query, sort, type],
  );
  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>) => setOpen(event.currentTarget.open);
  const exportCsv = () => {
    try {
      const url = URL.createObjectURL(new Blob([tagsCsv(visible)], { type: "text/csv;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "gitdash-tags.csv";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDownloadStatus("success");
    } catch {
      setDownloadStatus("error");
    }
  };

  return (
    <details className="tag-explorer" onToggle={onToggle}>
      <summary>タグを調べる <span>一覧・検索・注釈</span></summary>
      <div className="tag-explorer-body">
        <div className="tag-explorer-heading">
          <div><h3>タグを読み取り専用で確認</h3><p>タグの参照先と作成者を確認し、注釈付きタグのメッセージを表示します。</p></div>
          <button className="tag-explorer-refresh" type="button" onClick={() => void loadInventory(true)} disabled={inventoryState === "loading"}>{inventoryState === "loading" ? "読み込み中…" : "一覧を更新"}</button>
        </div>

        {inventoryState === "loading" && !inventory && <p className="tag-explorer-state" role="status">タグ一覧を読み込んでいます…</p>}
        {inventoryError && <div className="tag-explorer-error" role="alert"><span>{inventoryError}</span><button type="button" onClick={() => void loadInventory(true)}>再試行</button></div>}

        {inventory && <>
          <div className="tag-explorer-tools">
            <label><span>タグ名を完全一致で検索</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例: v2.0" aria-label="タグ名を完全一致で検索" /></label>
            <label><span>種類</span><select value={type} onChange={(event) => setType(event.target.value as "all" | TagType)} aria-label="タグの種類で絞り込み">{TAG_TYPES.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label>
            <label><span>並び順</span><select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="タグの並び順">{TAG_SORTS.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label>
            <span className="tag-explorer-count" role="status">{visible.length} / {inventory.tags.length} 件</span>
            <button className="tag-explorer-export" type="button" onClick={exportCsv} disabled={visible.length === 0}>表示中をCSV保存</button>
            <span className={`tag-explorer-download-status${downloadStatus === "error" ? " is-error" : ""}`} role={downloadStatus === "error" ? "alert" : "status"} aria-live="polite">{downloadStatus === "success" ? "CSVの保存を開始しました。" : downloadStatus === "error" ? "CSVを保存できませんでした。" : ""}</span>
          </div>

          {inventory.tags.length === 0 ? <p className="tag-explorer-empty">タグはありません。</p> : visible.length === 0 ? <p className="tag-explorer-empty">条件に一致するタグはありません。</p> : <div className="tag-explorer-table-wrap"><table className="tag-explorer-table"><thead><tr><th>タグ名</th><th>種類</th><th>タグobject</th><th>参照先</th><th>作成者・日付</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{visible.map((tag) => <tr key={tag.name} className={tag.name === selectedName ? "is-selected" : undefined}><td><button className="tag-explorer-select" type="button" onClick={() => setSelectedName(tag.name)} aria-pressed={tag.name === selectedName}><strong>{tag.name}</strong></button></td><td><span className={`tag-explorer-type tag-explorer-type-${tag.type}`}>{typeLabel(tag.type)}</span></td><td><code title={tag.hash}>{shortHash(tag.hash)}</code><CopyButton value={tag.hash} label={`${tag.name} のtag object hashをコピー`} /></td><td><code title={tag.peeled_hash || undefined}>{shortHash(tag.peeled_hash)}</code><span className="tag-explorer-target-type">{tag.peeled_type || "対象不明"}</span></td><td><span>{tagCreatorIdentity(tag.creator) ?? "作成者未取得"}</span><time dateTime={tag.creator_date || undefined}>{exactDate(tag.creator_date)}</time></td><td><button className="tag-explorer-detail-button" type="button" onClick={() => setSelectedName(tag.name)}>詳細</button></td></tr>)}</tbody></table></div>}
        </>}

        {detailState === "loading" && <p className="tag-explorer-state" role="status">選択したタグを読み込んでいます…</p>}
        {detailError && <p className="tag-explorer-error" role="alert">{detailError}</p>}
        {detail && <section className="tag-explorer-detail" aria-labelledby="tag-explorer-detail-title"><div className="tag-explorer-detail-heading"><div><h3 id="tag-explorer-detail-title">{detail.name}</h3><p><span className={`tag-explorer-type tag-explorer-type-${detail.type}`}>{typeLabel(detail.type)}</span><time dateTime={detail.creator_date || undefined}>{exactDate(detail.creator_date)}</time></p></div><div className="tag-explorer-detail-hash"><code>{detail.hash}</code><CopyButton value={detail.hash} label={`${detail.name} のtag object hashをコピー`} /></div></div>{detail.annotation ? <div className="tag-explorer-annotation"><h4>注釈</h4><dl><div><dt>tag</dt><dd>{detail.annotation.tag}</dd></div><div><dt>tagger</dt><dd>{detail.annotation.tagger || "作成者未取得"}</dd></div><div><dt>object</dt><dd><code>{detail.annotation.object_hash}</code>（{detail.annotation.object_type}）</dd></div></dl><pre>{detail.annotation.message || "メッセージはありません。"}</pre>{detail.annotation.message_truncated && <p className="tag-explorer-note" role="status">メッセージが大きいため、一部を省略しています。</p>}</div> : <p className="tag-explorer-note" role="status">軽量タグには注釈メッセージがありません。</p>}<div className="tag-explorer-target"><h4>対象コミット</h4><TagTarget detail={detail} commit={commit} state={commitState} error={commitError} /></div></section>}
      </div>
    </details>
  );
}

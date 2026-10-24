"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import CopyButton from "./copy-button";
import type { CommitDetail } from "./types";
import {
  adjacentTags,
  collapseTagTargets,
  encodeTagCreatorFilter,
  filterTagInvestigation,
  hasUnknownTagCreator,
  TAG_CREATOR_DATE_ALL,
  TAG_CREATOR_DATE_FILTERS,
  TAG_CREATOR_DATE_UNKNOWN,
  TAG_OBJECT_TYPES,
  tagCreatorDateRangeError,
  tagCreatorIdentities,
  tagInvestigationMarkdown,
  tagSelectionVisibility,
  tagTargetGroupSize,
  tagsJson,
  UNKNOWN_TAG_CREATOR_FILTER,
  UNKNOWN_TAG_OBJECT_TYPE_FILTER,
} from "./tag-investigation-tools.mjs";
import { TAG_SORTS, TAG_TYPES, tagCreatorIdentity, tagsCsv } from "./tag-explorer-tools.mjs";
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
type TagCreatorDatePresence = "all" | "known" | "unknown";

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
  const [creatorFilter, setCreatorFilter] = useState("");
  const [objectType, setObjectType] = useState("");
  const [startDate, setStartDate] = useState<string | null>(null);
  const [endDate, setEndDate] = useState<string | null>(null);
  const [datePresence, setDatePresence] = useState<TagCreatorDatePresence>(TAG_CREATOR_DATE_ALL);
  const [sort, setSort] = useState("name");
  const [collapseTargets, setCollapseTargets] = useState(false);
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
  const [downloadStatus, setDownloadStatus] = useState<"idle" | "csv-success" | "json-success" | "error">("idle");
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

  const filterOptions = useMemo(() => ({
    query,
    type,
    creatorFilter,
    objectType,
    startDate,
    endDate,
    datePresence,
    sort,
    collapseTargets,
  }), [collapseTargets, creatorFilter, datePresence, endDate, objectType, query, sort, startDate, type]);
  const filtered: TagSummary[] = useMemo(
    () => filterTagInvestigation(inventory?.tags ?? [], filterOptions) as TagSummary[],
    [filterOptions, inventory?.tags],
  );
  const visible: TagSummary[] = useMemo(
    () => collapseTagTargets(filtered, collapseTargets) as TagSummary[],
    [collapseTargets, filtered],
  );
  const creatorIdentities = useMemo(() => tagCreatorIdentities(inventory?.tags ?? []), [inventory?.tags]);
  const includesUnknownCreator = useMemo(() => hasUnknownTagCreator(inventory?.tags ?? []), [inventory?.tags]);
  const dateRangeError = useMemo(() => tagCreatorDateRangeError(startDate, endDate), [endDate, startDate]);
  const navigation = useMemo(() => adjacentTags(visible, selectedName), [selectedName, visible]);
  const selectionVisibility = useMemo(() => tagSelectionVisibility(filtered, visible, selectedName), [filtered, selectedName, visible]);
  const tagReport = useMemo(() => detail ? tagInvestigationMarkdown(detail, path, commit) : null, [commit, detail, path]);

  useEffect(() => {
    setDownloadStatus("idle");
  }, [collapseTargets, creatorFilter, datePresence, endDate, objectType, query, sort, startDate, type]);

  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>) => setOpen(event.currentTarget.open);
  const exportCsv = () => {
    try {
      const url = URL.createObjectURL(new Blob([tagsCsv(visible)], { type: "text/csv;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "gitdash-tags.csv";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDownloadStatus("csv-success");
    } catch {
      setDownloadStatus("error");
    }
  };
  const exportJson = () => {
    try {
      const url = URL.createObjectURL(new Blob([tagsJson(visible, { repositoryPath: path, filters: filterOptions })], { type: "application/json;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "gitdash-tags.json";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDownloadStatus("json-success");
    } catch {
      setDownloadStatus("error");
    }
  };
  const clearFilters = () => {
    setQuery("");
    setType("all");
    setCreatorFilter("");
    setObjectType("");
    setStartDate(null);
    setEndDate(null);
    setDatePresence(TAG_CREATOR_DATE_ALL);
    setSort("name");
    setCollapseTargets(false);
  };
  const hasFilters = query.trim() !== ""
    || type !== "all"
    || creatorFilter !== ""
    || objectType !== ""
    || startDate !== null
    || endDate !== null
    || datePresence !== TAG_CREATOR_DATE_ALL
    || sort !== "name"
    || collapseTargets;
  const clearSelection = () => setSelectedName(null);

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
          <div className="tag-explorer-tools" role="group" aria-label="タグ一覧の絞り込みと操作">
            <label><span>タグ名を完全一致で検索</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例: v2.0" aria-label="タグ名を完全一致で検索" /></label>
            <label><span>種類</span><select value={type} onChange={(event) => setType(event.target.value as "all" | TagType)} aria-label="タグの種類で絞り込み">{TAG_TYPES.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label>
            <label><span>作成者（完全一致）</span><select value={creatorFilter} onChange={(event) => setCreatorFilter(event.target.value)} aria-label="タグの作成者で完全一致絞り込み"><option value="">すべて</option>{creatorIdentities.map((identity) => <option key={identity} value={encodeTagCreatorFilter(identity)}>{identity}</option>)}{includesUnknownCreator && <option value={UNKNOWN_TAG_CREATOR_FILTER}>作成者未取得</option>}</select></label>
            <label><span>対象object type</span><select value={objectType} onChange={(event) => setObjectType(event.target.value)} aria-label="タグの対象object typeで絞り込み"><option value="">すべて</option>{TAG_OBJECT_TYPES.map((value) => <option key={value} value={value}>{value}</option>)}<option value={UNKNOWN_TAG_OBJECT_TYPE_FILTER}>対象不明</option></select></label>
            <label><span>作成日の状態</span><select value={datePresence} onChange={(event) => { const next = event.target.value as TagCreatorDatePresence; setDatePresence(next); if (next === TAG_CREATOR_DATE_UNKNOWN) { setStartDate(null); setEndDate(null); } }} aria-label="タグ作成日の取得状態で絞り込み">{TAG_CREATOR_DATE_FILTERS.map((value) => <option key={value} value={value}>{value === TAG_CREATOR_DATE_ALL ? "すべて" : value === "known" ? "作成日あり" : "作成日未取得"}</option>)}</select></label>
            <label><span>開始日（ローカル）</span><input type="date" value={startDate ?? ""} disabled={datePresence === TAG_CREATOR_DATE_UNKNOWN} onChange={(event) => setStartDate(event.target.value || null)} aria-label="タグ作成日の開始日（ローカル）" aria-invalid={Boolean(dateRangeError)} aria-describedby={dateRangeError ? "tag-explorer-date-error" : undefined} /></label>
            <label><span>終了日（ローカル）</span><input type="date" value={endDate ?? ""} disabled={datePresence === TAG_CREATOR_DATE_UNKNOWN} onChange={(event) => setEndDate(event.target.value || null)} aria-label="タグ作成日の終了日（ローカル）" aria-invalid={Boolean(dateRangeError)} aria-describedby={dateRangeError ? "tag-explorer-date-error" : undefined} /></label>
            <label><span>並び順</span><select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="タグの並び順">{TAG_SORTS.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label>
            <label className="tag-explorer-collapse"><input type="checkbox" checked={collapseTargets} onChange={(event) => setCollapseTargets(event.target.checked)} aria-label="同じ対象objectを代表タグ1件にまとめる" /><span>同一対象をまとめる</span></label>
            <div className="tag-explorer-filter-actions">
              <button className="tag-explorer-export" type="button" onClick={clearFilters} disabled={!hasFilters} aria-label="タグの絞り込みと並び順をリセット">条件をリセット</button>
              <button className="tag-explorer-export" type="button" onClick={exportCsv} disabled={visible.length === 0 || Boolean(dateRangeError)} aria-label="表示中のタグ一覧をCSVで保存">表示中をCSV保存</button>
              <button className="tag-explorer-export" type="button" onClick={exportJson} disabled={visible.length === 0 || Boolean(dateRangeError)} aria-label="表示中のタグ一覧をJSONで保存">表示中をJSON保存</button>
            </div>
            <div className="tag-explorer-count" role="status"><span>{visible.length} / 条件一致 {filtered.length} / 全体 {inventory.tags.length} 件</span>{navigation.index >= 0 && <span>選択 {navigation.index + 1} / {navigation.count}</span>}{selectedName && selectionVisibility === "filtered" && <span>選択中タグは現在の条件外</span>}{selectedName && selectionVisibility === "collapsed" && <span>選択中タグは代表表示に集約</span>}{downloadStatus === "csv-success" ? <span aria-live="polite">CSVの保存を開始しました。</span> : downloadStatus === "json-success" ? <span aria-live="polite">JSONの保存を開始しました。</span> : downloadStatus === "error" ? <span className="is-error" role="alert">一覧を保存できませんでした。</span> : null}</div>
          </div>

          {dateRangeError && <p className="tag-explorer-date-error" id="tag-explorer-date-error" role="alert">{dateRangeError}</p>}

          {selectedName && selectionVisibility === "filtered" && <div className="tag-explorer-selection-notice" role="status"><span>選択中のタグ「{selectedName}」は現在の絞り込み条件で非表示です。</span><button type="button" onClick={clearSelection} aria-label="現在の条件外になったタグの選択を解除">選択を解除</button></div>}
          {selectedName && selectionVisibility === "collapsed" && <div className="tag-explorer-selection-notice" role="status"><span>選択中のタグ「{selectedName}」は同じ対象objectの代表タグにまとめられているため、一覧では非表示です。詳細の選択は保持しています。</span><button type="button" onClick={clearSelection} aria-label="集約されたタグの選択を解除">選択を解除</button></div>}

          {inventory.tags.length === 0 ? <p className="tag-explorer-empty">タグはありません。</p> : visible.length === 0 ? <p className="tag-explorer-empty">{dateRangeError ? "日付範囲が無効なため、タグを表示できません。" : "条件に一致するタグはありません。"}</p> : <div className="tag-explorer-table-wrap"><table className="tag-explorer-table"><caption className="sr-only">表示中のタグ一覧</caption><thead><tr><th scope="col">タグ名</th><th scope="col">種類</th><th scope="col">タグobject</th><th scope="col">参照先</th><th scope="col">作成者・日付</th><th scope="col"><span className="sr-only">操作</span></th></tr></thead><tbody>{visible.map((tag) => { const groupSize = collapseTargets ? tagTargetGroupSize(filtered, tag) : 1; return <tr key={tag.name} className={tag.name === selectedName ? "is-selected" : undefined}><td><button className="tag-explorer-select" type="button" onClick={() => setSelectedName(tag.name)} aria-pressed={tag.name === selectedName}><strong>{tag.name}</strong>{groupSize > 1 && <span className="tag-explorer-collapse-label">同一対象 {groupSize}件の代表</span>}</button></td><td><span className={`tag-explorer-type tag-explorer-type-${tag.type}`}>{typeLabel(tag.type)}</span></td><td><code title={tag.hash}>{shortHash(tag.hash)}</code><CopyButton value={tag.hash} label={`${tag.name} のtag object hashをコピー`} /></td><td><code title={tag.peeled_hash || undefined}>{shortHash(tag.peeled_hash)}</code><span className="tag-explorer-target-type">{tag.peeled_type || "対象不明"}</span></td><td><span>{tagCreatorIdentity(tag.creator) ?? "作成者未取得"}</span><time dateTime={tag.creator_date || undefined}>{exactDate(tag.creator_date)}</time></td><td><button className="tag-explorer-detail-button" type="button" onClick={() => setSelectedName(tag.name)} aria-label={`${tag.name}の詳細を表示`}>詳細</button></td></tr>; })}</tbody></table></div>}
          <div className="tag-explorer-navigation" role="group" aria-label="表示中タグの移動">
            <button type="button" className="tag-explorer-export" onClick={() => navigation.previous && setSelectedName(navigation.previous.name)} disabled={navigation.previous === null} aria-label="前の表示中タグを選択">← 前のタグ</button>
            <span role="status">{navigation.index >= 0 ? `選択 ${navigation.index + 1} / ${navigation.count}` : selectedName ? selectionVisibility === "collapsed" ? "選択中タグは同一対象に集約されています" : "選択中タグは現在の条件外です" : "タグを選択してください"}</span>
            <button type="button" className="tag-explorer-export" onClick={() => navigation.next && setSelectedName(navigation.next.name)} disabled={navigation.next === null} aria-label="次の表示中タグを選択">次のタグ →</button>
          </div>
        </>}

        {detailState === "loading" && <p className="tag-explorer-state" role="status">選択したタグを読み込んでいます…</p>}
        {detailError && <p className="tag-explorer-error" role="alert">{detailError}</p>}
        {detail && <section className="tag-explorer-detail" aria-labelledby="tag-explorer-detail-title"><div className="tag-explorer-detail-heading"><div><h3 id="tag-explorer-detail-title">{detail.name}</h3><p><span className={`tag-explorer-type tag-explorer-type-${detail.type}`}>{typeLabel(detail.type)}</span><time dateTime={detail.creator_date || undefined}>{exactDate(detail.creator_date)}</time></p></div><div className="tag-explorer-detail-actions"><div className="tag-explorer-detail-hash"><code>{detail.hash}</code><CopyButton value={detail.hash} label={`${detail.name} のtag object hashをコピー`} /></div>{tagReport && <CopyButton value={tagReport} label="選択したタグのMarkdownレポートをコピー" />}</div></div>{detail.annotation ? <div className="tag-explorer-annotation"><h4>注釈</h4><dl><div><dt>tag</dt><dd>{detail.annotation.tag}</dd></div><div><dt>tagger</dt><dd>{detail.annotation.tagger || "作成者未取得"}</dd></div><div><dt>object</dt><dd><code>{detail.annotation.object_hash}</code>（{detail.annotation.object_type}）</dd></div></dl><pre>{detail.annotation.message || "メッセージはありません。"}</pre>{detail.annotation.message_truncated && <p className="tag-explorer-note" role="status">メッセージが大きいため、一部を省略しています。</p>}</div> : <p className="tag-explorer-note" role="status">軽量タグには注釈メッセージがありません。</p>}<div className="tag-explorer-target"><h4>{detail.peeled_type === "commit" ? "対象コミット" : "対象オブジェクト"}</h4><TagTarget detail={detail} commit={commit} state={commitState} error={commitError} /></div></section>}
      </div>
    </details>
  );
}

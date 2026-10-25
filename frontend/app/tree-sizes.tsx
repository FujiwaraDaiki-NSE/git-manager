"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  aggregateTreeSizeDirectories,
  aggregateTreeSizeEntries,
  aggregateTreeSizeObjectSummary,
  filterTreeSizeEntries,
  formatTreeSizeBytes,
  listTreeSizeExtensions,
  maximumTreeSizeError,
  minimumTreeSizeError,
  parseMaximumTreeSize,
  parseMinimumTreeSize,
  sortTreeSizeEntries,
  treeSizeBreadcrumbs,
  treeSizeKind,
  treeSizeKindLabel,
  treeSizeRangeError,
  treeSizesJson,
  treeSizesPathLines,
  treeSizesCsv,
  treeSizesQuery,
  TREE_SIZE_EXTENSION_ALL,
  TREE_SIZE_EXTENSION_NONE,
  TREE_SIZE_FILTER_ALL,
  TREE_SIZE_FILTER_KNOWN,
  TREE_SIZE_FILTER_UNKNOWN,
} from "./tree-sizes-tools.mjs";
import "./tree-sizes.css";
import CopyButton from "./copy-button";

type TreeSizeEntry = {
  path: string;
  mode: string;
  type: string;
  hash: string;
  size: number | null;
};

type TreeSizesInventory = {
  revision: string;
  pinned_hash: string;
  entries: TreeSizeEntry[];
  total_bytes: number;
  file_count: number;
  unknown_size_count: number;
  truncated: boolean;
  limit: number;
  byte_limit: number;
};

type LoadState = "idle" | "loading" | "ready" | "error";
type TreeSizeKindFilter = "all" | "regular" | "symlink" | "gitlink";
type TreeSizeSizeFilter = "all" | "known" | "unknown";
type TreeSizeOrder = "size" | "path";
type TreeSizeDirection = "ascending" | "descending";

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isFullHash(value: unknown): value is string {
  return isString(value) && /^[0-9a-f]{40,64}$/iu.test(value);
}

function isEntry(value: unknown): value is TreeSizeEntry {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<TreeSizeEntry>;
  const size = item.size;
  return isString(item.path)
    && isString(item.mode)
    && isString(item.type)
    && isString(item.hash)
    && (size === null || (typeof size === "number" && Number.isSafeInteger(size) && size >= 0));
}

function isInventory(value: unknown): value is TreeSizesInventory {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<TreeSizesInventory>;
  const totalBytes = item.total_bytes;
  const fileCount = item.file_count;
  const unknownSizeCount = item.unknown_size_count;
  return isString(item.revision)
    && isFullHash(item.pinned_hash)
    && Array.isArray(item.entries)
    && item.entries.every(isEntry)
    && typeof totalBytes === "number"
    && Number.isSafeInteger(totalBytes)
    && totalBytes >= 0
    && typeof fileCount === "number"
    && Number.isSafeInteger(fileCount)
    && fileCount >= 0
    && typeof unknownSizeCount === "number"
    && Number.isSafeInteger(unknownSizeCount)
    && unknownSizeCount >= 0
    && typeof item.truncated === "boolean"
    && Number.isSafeInteger(item.limit)
    && Number.isSafeInteger(item.byte_limit);
}

async function responseError(response: Response) {
  try {
    const body = await response.json() as { detail?: unknown };
    if (typeof body.detail === "string" && body.detail) return body.detail;
  } catch {
    // The HTTP status remains useful when a proxy responds with non-JSON text.
  }
  return `HTTP ${response.status}`;
}

function shortHash(value: string) {
  return value.slice(0, 12);
}

function treeSizePathWithinDirectory(path: string, directory: string) {
  const prefix = directory ? `${directory}/` : "";
  return path.startsWith(prefix);
}

function directoryLabel(directory: string) {
  return directory || "ルート";
}

export default function TreeSizes({ path }: { path: string }) {
  const [revision, setRevision] = useState("");
  const [directory, setDirectory] = useState("");
  const [pathFilter, setPathFilter] = useState("");
  const [kindFilter, setKindFilter] = useState<TreeSizeKindFilter>("all");
  const [minimumBytesText, setMinimumBytesText] = useState("");
  const [maximumBytesText, setMaximumBytesText] = useState("");
  const [sizeFilter, setSizeFilter] = useState<TreeSizeSizeFilter>(TREE_SIZE_FILTER_ALL);
  const [extension, setExtension] = useState<string>(TREE_SIZE_EXTENSION_ALL);
  const [duplicateOnly, setDuplicateOnly] = useState(false);
  const [order, setOrder] = useState<TreeSizeOrder>("size");
  const [direction, setDirection] = useState<TreeSizeDirection>("descending");
  const [inventory, setInventory] = useState<TreeSizesInventory | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const requestKeyRef = useRef<string | null>(null);

  const resetFilters = () => {
    setDirectory("");
    setPathFilter("");
    setKindFilter("all");
    setMinimumBytesText("");
    setMaximumBytesText("");
    setSizeFilter(TREE_SIZE_FILTER_ALL);
    setExtension(TREE_SIZE_EXTENSION_ALL);
    setDuplicateOnly(false);
    setOrder("size");
    setDirection("descending");
  };

  useEffect(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    requestKeyRef.current = null;
    setRevision("");
    setInventory(null);
    setLoadState("idle");
    setLoadError(null);
    resetFilters();
    setOpen(false);
  }, [path]);

  const handleRevisionChange = (value: string) => {
    // Invalidate synchronously in the input event. A late response must not
    // win the small gap before React runs an effect for the new value.
    controllerRef.current?.abort();
    controllerRef.current = null;
    requestKeyRef.current = null;
    setRevision(value);
    setInventory(null);
    setLoadState("idle");
    setLoadError(null);
    resetFilters();
  };

  const loadInventory = () => {
    if (!path) {
      setLoadError("リポジトリのパスを取得できないため読み込めません。");
      setLoadState("error");
      return;
    }
    if (!revision) {
      setLoadError("revisionを指定してください。");
      setLoadState("error");
      return;
    }
    controllerRef.current?.abort();
    const controller = new AbortController();
    const requestKey = JSON.stringify([path, revision]);
    controllerRef.current = controller;
    requestKeyRef.current = requestKey;
    setLoadState("loading");
    setLoadError(null);
    setInventory(null);
    resetFilters();
    setOpen(true);
    const params = treeSizesQuery(path, revision);
    void fetch(`/api/repo/tree-sizes?${params}`, { cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(await responseError(response));
      const value: unknown = await response.json();
      if (!isInventory(value)) throw new Error("ファイル容量の応答形式が不正です。");
      if (value.revision !== revision || !isFullHash(value.pinned_hash)) throw new Error("ファイル容量のrevision固定情報が不正です。");
      return value;
    }).then((value) => {
      if (controller.signal.aborted || requestKeyRef.current !== requestKey) return;
      setInventory(value);
      setLoadState("ready");
    }).catch((caught: unknown) => {
      if (controller.signal.aborted || requestKeyRef.current !== requestKey) return;
      setLoadError(caught instanceof Error ? caught.message : "ファイル容量を取得できませんでした。");
      setLoadState("error");
    }).finally(() => {
      if (controllerRef.current === controller && requestKeyRef.current === requestKey) controllerRef.current = null;
    });
  };

  const minimumError = minimumTreeSizeError(minimumBytesText);
  const minimumBytes = parseMinimumTreeSize(minimumBytesText);
  const maximumError = maximumTreeSizeError(maximumBytesText);
  const maximumBytes = parseMaximumTreeSize(maximumBytesText);
  const sizeRangeError = treeSizeRangeError(minimumBytes, maximumBytes);
  const extensionOptions = useMemo(
    () => inventory ? listTreeSizeExtensions(inventory.entries) : [],
    [inventory],
  );
  const scopedEntries = useMemo(() => {
    if (!inventory) return [];
    return inventory.entries.filter((entry) => treeSizePathWithinDirectory(entry.path, directory));
  }, [directory, inventory]);
  const visibleEntries = useMemo(() => {
    if (!inventory || minimumError || maximumError || sizeRangeError) return [];
    return sortTreeSizeEntries(filterTreeSizeEntries(inventory.entries, {
      directory,
      pathQuery: pathFilter,
      kind: kindFilter,
      minimumBytes,
      maximumBytes,
      sizeFilter,
      extension,
      duplicateOnly,
    }), order, direction);
  }, [directory, direction, duplicateOnly, extension, inventory, kindFilter, maximumBytes, maximumError, minimumBytes, minimumError, order, pathFilter, sizeFilter, sizeRangeError]);
  const directoryAggregates = useMemo(() => aggregateTreeSizeDirectories(scopedEntries, directory), [directory, scopedEntries]);
  const scopedSummary = useMemo(() => aggregateTreeSizeEntries(scopedEntries), [scopedEntries]);
  const objectSummary = useMemo(() => aggregateTreeSizeObjectSummary(visibleEntries), [visibleEntries]);
  const largestEntry = useMemo(
    () => sortTreeSizeEntries(visibleEntries, "size", "descending").find((entry) => entry.size !== null) ?? null,
    [visibleEntries],
  );
  const breadcrumbs = useMemo(() => treeSizeBreadcrumbs(directory), [directory]);
  const chartMaximum = Math.max(1, ...directoryAggregates.map((item) => item.totalBytes));
  const hasFilters = directory !== ""
    || pathFilter !== ""
    || kindFilter !== "all"
    || minimumBytesText !== ""
    || maximumBytesText !== ""
    || sizeFilter !== TREE_SIZE_FILTER_ALL
    || extension !== TREE_SIZE_EXTENSION_ALL
    || duplicateOnly
    || order !== "size"
    || direction !== "descending";

  const exportCsv = () => {
    if (!visibleEntries.length || minimumError || maximumError || sizeRangeError) return;
    const blob = new Blob([treeSizesCsv(visibleEntries)], { type: "text/csv;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const safeRevision = revision.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").trim();
    anchor.href = href;
    anchor.download = `gitdash-tree-sizes-${safeRevision || "revision"}.csv`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(href), 1000);
  };

  const snapshotConditions = {
    directory,
    pathQuery: pathFilter,
    kind: kindFilter,
    minimumBytes,
    maximumBytes,
    sizeFilter,
    extension,
    duplicateOnly,
    order,
    direction,
  };
  const exportJson = () => {
    if (!inventory || !visibleEntries.length || minimumError || maximumError || sizeRangeError) return;
    const blob = new Blob([treeSizesJson(visibleEntries, inventory, snapshotConditions, path)], { type: "application/json;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const safeRevision = revision.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").trim();
    anchor.href = href;
    anchor.download = `gitdash-tree-sizes-${safeRevision || "revision"}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(href), 1000);
  };
  const visiblePathLines = useMemo(() => treeSizesPathLines(visibleEntries), [visibleEntries]);
  const resetTreeSizeFilters = () => resetFilters();

  return (
    <details className="tree-sizes" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary id="tree-sizes-title">版ごとのファイル容量を調べる <span>固定revision・最大ファイル・ディレクトリ集計</span></summary>
      <div className="tree-sizes-body">
        <div className="tree-sizes-heading">
          <div>
            <h3>Gitの版に含まれる容量を確認</h3>
            <p>指定したrevisionのGitオブジェクトだけを読み取り、パスごとの参照バイト数を集計します。</p>
          </div>
          <code className="tree-sizes-repo" title={path}>{path}</code>
        </div>

        <div className="tree-sizes-inputs" role="group" aria-label="tree-sizeの対象revision">
          <label><span>revision（必須）</span><input id="tree-sizes-revision" type="text" value={revision} onChange={(event) => handleRevisionChange(event.target.value)} placeholder="HEAD、ブランチ名、完全ハッシュ" aria-label="容量調査のrevision" /></label>
          <button id="tree-sizes-load" type="button" className="primary-action" disabled={!revision || loadState === "loading"} onClick={loadInventory}>{loadState === "loading" ? "容量を取得中…" : "版の容量を取得"}</button>
        </div>

        {loadState === "error" && <p className="tree-sizes-error" role="alert">ファイル容量を取得できませんでした。{loadError && <span>（{loadError}）</span>}</p>}
        {loadState === "idle" && !inventory && <p className="tree-sizes-empty" role="status">revisionを指定して容量一覧を取得してください。</p>}

        {inventory && (
          <section className="tree-sizes-inventory" aria-labelledby="tree-sizes-inventory-title">
            <div className="tree-sizes-inventory-heading">
              <div><h4 id="tree-sizes-inventory-title">取得済みパスの容量</h4><p><code>{shortHash(inventory.pinned_hash)}</code> に固定 · {inventory.file_count.toLocaleString()}件</p></div>
              <span className="tree-sizes-count" role="status">{directoryLabel(directory)} · {scopedSummary.fileCount.toLocaleString()}件</span>
            </div>
            <div className="tree-sizes-summary" aria-label="取得済み容量の集計">
              <div><span>取得済み合計</span><strong>{formatTreeSizeBytes(inventory.total_bytes)}</strong></div>
              <div><span>現在の範囲</span><strong>{formatTreeSizeBytes(scopedSummary.totalBytes)}</strong></div>
              <div><span>サイズ未取得</span><strong>{scopedSummary.unknownSizeCount.toLocaleString()}件</strong></div>
              {largestEntry && <div className="tree-sizes-largest"><span>現在の最大ファイル</span><strong title={largestEntry.path}>{largestEntry.path}</strong><small>{formatTreeSizeBytes(largestEntry.size)}</small></div>}
            </div>
            {inventory.truncated && <p className="tree-sizes-truncated" role="status">Gitの出力は{inventory.limit.toLocaleString()}件または{formatTreeSizeBytes(inventory.byte_limit)}で切り詰められました。合計とディレクトリ集計は取得済みパスだけの部分集計で、完全な値ではありません。</p>}
            {inventory.unknown_size_count > 0 && <p className="tree-sizes-note" role="note">gitlinkなど{inventory.unknown_size_count.toLocaleString()}件は内容サイズを取得できないため、合計に含めず未取得として表示します。</p>}

            <div className="tree-sizes-tools" role="group" aria-label="容量一覧の絞り込みと並び順">
              <label><span>パス検索</span><input id="tree-sizes-path-filter" type="search" value={pathFilter} onChange={(event) => setPathFilter(event.target.value)} placeholder="取得済みパスを検索" aria-label="容量一覧のパス検索" /></label>
              <label><span>種類</span><select id="tree-sizes-type-filter" value={kindFilter} onChange={(event) => setKindFilter(event.target.value as TreeSizeKindFilter)} aria-label="容量一覧の種類フィルター"><option value="all">すべて</option><option value="regular">regular</option><option value="symlink">symlink</option><option value="gitlink">gitlink</option></select></label>
              <label><span>最小サイズ（バイト）</span><input id="tree-sizes-min-bytes" type="text" inputMode="numeric" value={minimumBytesText} onChange={(event) => setMinimumBytesText(event.target.value)} placeholder="未指定" aria-invalid={Boolean(minimumError)} aria-describedby={minimumError ? "tree-sizes-min-bytes-error" : undefined} /></label>
              <label><span>最大サイズ（バイト）</span><input id="tree-sizes-max-bytes" type="text" inputMode="numeric" value={maximumBytesText} onChange={(event) => setMaximumBytesText(event.target.value)} placeholder="未指定（0も可）" aria-invalid={Boolean(maximumError)} aria-describedby={maximumError ? "tree-sizes-max-bytes-error" : undefined} /></label>
              <label><span>サイズ状態</span><select id="tree-sizes-size-filter" value={sizeFilter} onChange={(event) => setSizeFilter(event.target.value as TreeSizeSizeFilter)} aria-label="容量一覧のサイズ状態フィルター"><option value={TREE_SIZE_FILTER_ALL}>判明・不明すべて</option><option value={TREE_SIZE_FILTER_KNOWN}>サイズ判明</option><option value={TREE_SIZE_FILTER_UNKNOWN}>サイズ不明</option></select></label>
              <label><span>拡張子（完全一致）</span><select id="tree-sizes-extension-filter" value={extension} onChange={(event) => setExtension(event.target.value)} aria-label="容量一覧の拡張子フィルター"><option value={TREE_SIZE_EXTENSION_ALL}>すべて</option>{extensionOptions.map((item) => <option key={item} value={item}>{item === TREE_SIZE_EXTENSION_NONE ? "拡張子なし" : item}</option>)}</select></label>
              <label className="tree-sizes-checkbox"><span>object重複</span><span><input id="tree-sizes-duplicate-filter" type="checkbox" checked={duplicateOnly} onChange={(event) => setDuplicateOnly(event.target.checked)} /> 同じtype+hashを複数pathが参照</span></label>
              <label><span>並び順</span><select id="tree-sizes-sort" value={order} onChange={(event) => setOrder(event.target.value as TreeSizeOrder)} aria-label="容量一覧の並び順"><option value="size">サイズ</option><option value="path">パス</option></select></label>
              <label><span>方向</span><select id="tree-sizes-sort-direction" value={direction} onChange={(event) => setDirection(event.target.value as TreeSizeDirection)} aria-label="容量一覧の並び方向"><option value="descending">降順</option><option value="ascending">昇順</option></select></label>
              <div className="tree-sizes-export-actions" role="group" aria-label="表示結果の保存とコピー">
                <button id="tree-sizes-csv" type="button" className="subtle-button" disabled={!visibleEntries.length || Boolean(minimumError) || Boolean(maximumError) || Boolean(sizeRangeError)} onClick={exportCsv}>絞り込み結果をCSV保存</button>
                <button id="tree-sizes-json" type="button" className="subtle-button" disabled={!visibleEntries.length || Boolean(minimumError) || Boolean(maximumError) || Boolean(sizeRangeError)} onClick={exportJson}>表示中をJSON保存</button>
                {visibleEntries.length > 0 && <CopyButton value={visiblePathLines} label="表示中pathをJSON行でコピー" />}
                <button id="tree-sizes-reset" type="button" className="subtle-button" disabled={!hasFilters} onClick={resetTreeSizeFilters}>条件をリセット</button>
              </div>
            </div>
            {minimumError && <p className="tree-sizes-input-error" id="tree-sizes-min-bytes-error" role="alert">{minimumError}</p>}
            {maximumError && <p className="tree-sizes-input-error" id="tree-sizes-max-bytes-error" role="alert">{maximumError}</p>}
            {sizeRangeError && <p className="tree-sizes-input-error" id="tree-sizes-range-error" role="alert">{sizeRangeError}</p>}

            <div className="tree-sizes-directory-toolbar" id="tree-sizes-directory" role="group" aria-label="ディレクトリ容量の範囲">
              <span>ディレクトリ範囲</span>
              <div className="tree-sizes-breadcrumbs"><button type="button" className={directory === "" ? "is-current" : ""} onClick={() => setDirectory("")}>ルート</button>{breadcrumbs.map((crumb: { name: string; path: string }) => <span key={crumb.path}><span aria-hidden="true">/</span><button type="button" className={directory === crumb.path ? "is-current" : ""} onClick={() => setDirectory(crumb.path)}>{crumb.name}</button></span>)}</div>
            </div>

            <section className="tree-sizes-objects" aria-labelledby="tree-sizes-objects-title">
              <div className="tree-sizes-subheading"><div><h4 id="tree-sizes-objects-title">表示中のGitオブジェクト別容量</h4><p>同じ種類・ハッシュを参照するパスを1つにまとめた容量です。</p></div></div>
              {visibleEntries.length === 0 ? <p className="tree-sizes-empty" role="status">object集計の対象となる表示中pathがありません。</p> : <>
                <div className="tree-sizes-object-summary" aria-label="表示中のpathとdistinct objectの容量比較">
                  <div><span>通常のパス合計（既知）</span><strong>{formatTreeSizeBytes(objectSummary.pathTotalBytes)}</strong><small>{objectSummary.pathUnknownSizeCount.toLocaleString()}件は不明</small></div>
                  <div><span>重複をまとめたobject合計（既知）</span><strong>{formatTreeSizeBytes(objectSummary.objectTotalBytes)}</strong><small>{objectSummary.objectUnknownSizeCount.toLocaleString()} objectは不明</small></div>
                  <div><span>object数（重複をまとめた単位）</span><strong>{objectSummary.objectCount.toLocaleString()}</strong><small>重複参照 {objectSummary.duplicateReferenceCount.toLocaleString()}件</small></div>
                </div>
                <p className="tree-sizes-object-note" role="note">取得済みの表示対象だけの集計です。不明サイズは合計に含みません。Gitのディスク使用量や削減可能な容量を示すものではありません。</p>
                <div className="tree-sizes-table-wrap" role="region" aria-label="object容量一覧" tabIndex={0}><table className="tree-sizes-table tree-sizes-object-table"><thead><tr><th scope="col">種類 / object</th><th scope="col">容量</th><th scope="col">参照パス数</th></tr></thead><tbody>{objectSummary.objects.map((object) => <tr key={`${object.type}:${object.hash}`}><th scope="row"><span>{object.type}</span> <code title={object.hash}>{shortHash(object.hash)}</code></th><td>{formatTreeSizeBytes(object.size)}</td><td>{object.referenceCount.toLocaleString()}</td></tr>)}</tbody></table></div>
              </>}
            </section>

            <section className="tree-sizes-directories" aria-labelledby="tree-sizes-directories-title">
              <div className="tree-sizes-subheading"><div><h4 id="tree-sizes-directories-title">ディレクトリ別の合計</h4><p>取得済みパスから計算した範囲別の集計です。行を選ぶとそのディレクトリへ移動します。</p></div></div>
              {directoryAggregates.length === 0 ? <p className="tree-sizes-empty" role="status">この範囲に子ディレクトリはありません。</p> : <>
                <div className="tree-sizes-chart" role="img" aria-label="ディレクトリ容量の棒グラフ">{directoryAggregates.map((item) => <button type="button" className="tree-sizes-chart-row" key={item.path} onClick={() => setDirectory(item.path)}><span className="tree-sizes-chart-label">{item.path}</span><span className="tree-sizes-chart-track"><span className="tree-sizes-chart-bar" style={{ width: `${Math.max(2, (item.totalBytes / chartMaximum) * 100)}%` }} /></span><strong>{formatTreeSizeBytes(item.totalBytes)}</strong></button>)}</div>
                <div className="tree-sizes-table-wrap" role="region" aria-label="ディレクトリ別容量一覧" tabIndex={0}><table className="tree-sizes-table"><thead><tr><th scope="col">ディレクトリ</th><th scope="col">合計</th><th scope="col">パス数</th><th scope="col">サイズ未取得</th><th scope="col"><span className="sr-only">操作</span></th></tr></thead><tbody>{directoryAggregates.map((item) => <tr key={item.path}><th scope="row"><code>{item.path}</code></th><td>{formatTreeSizeBytes(item.totalBytes)}</td><td>{item.fileCount.toLocaleString()}</td><td>{item.unknownSizeCount.toLocaleString()}</td><td><button type="button" className="table-action" onClick={() => setDirectory(item.path)}>この範囲を見る</button></td></tr>)}</tbody></table></div>
              </>}
            </section>

            <section className="tree-sizes-files" aria-labelledby="tree-sizes-files-title">
              <div className="tree-sizes-subheading"><div><h4 id="tree-sizes-files-title">ファイルインベントリ</h4><p>{visibleEntries.length.toLocaleString()}件の取得済みパスを表示 · サイズ順は不明値を最後に配置</p></div></div>
              {visibleEntries.length === 0 ? <p className="tree-sizes-empty" role="status">条件に一致する取得済みパスはありません。</p> : <div className="tree-sizes-table-wrap" role="region" aria-label="ファイル容量一覧" tabIndex={0}><table className="tree-sizes-table tree-sizes-file-table"><thead><tr><th scope="col">パス</th><th scope="col">種類</th><th scope="col">容量</th><th scope="col">object</th></tr></thead><tbody>{visibleEntries.map((entry) => <tr key={`${entry.type}:${entry.path}`}><th scope="row"><code title={entry.path}>{entry.path}</code></th><td><span className={`tree-sizes-kind tree-sizes-kind-${treeSizeKind(entry)}`}>{treeSizeKindLabel(treeSizeKind(entry))}</span></td><td>{formatTreeSizeBytes(entry.size)}</td><td><code title={entry.hash}>{shortHash(entry.hash)}</code></td></tr>)}</tbody></table></div>}
            </section>
          </section>
        )}
      </div>
    </details>
  );
}

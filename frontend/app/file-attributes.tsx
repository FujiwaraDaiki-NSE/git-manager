"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  EOL_FILTERS,
  EOL_FILTER_ALL,
  FILE_ATTRIBUTES_DIRECTORY_ALL,
  FILE_ATTRIBUTES_DIRECTORY_ROOT,
  FILE_ATTRIBUTE_MODES,
  attributesForPath,
  compareFileAttributes,
  fileAttributesCsv,
  fileAttributesEolQuery,
  fileAttributesRequestBody,
  filterFileAttributeEntries,
  listFileAttributeDirectories,
  sortFileAttributeEntries,
} from "./file-attributes-tools.mjs";
import "./file-attributes.css";

type EolFilter = "all" | "anomalous" | "mixed" | "unknown";
type AttributeMode = "worktree" | "index";
type LoadState = "idle" | "loading" | "ready" | "error";

type EolEntry = {
  path: string;
  index_eol: string;
  worktree_eol: string;
  attributes: string;
  attribute_eol: string | null;
  flags: string[];
  eol_status: string;
};

type EolResponse = {
  entries: EolEntry[];
  truncated: boolean;
  limit: number;
  byte_limit: number;
  command?: string;
};

type AttributeEntry = {
  path: string;
  attributes: Record<string, string>;
};

type AttributeResponse = {
  mode: AttributeMode;
  paths: string[];
  entries: AttributeEntry[];
  limit: number;
  byte_limit: number;
  command?: string;
};

type FileAttributesProps = {
  path: string;
};

function responseError(response: Response) {
  return response
    .json()
    .then((body: unknown) => {
      if (body && typeof body === "object" && "detail" in body && typeof body.detail === "string") return body.detail;
      return `HTTP ${response.status}`;
    })
    .catch(() => `HTTP ${response.status}`);
}

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal });
  if (!response.ok) throw new Error(await responseError(response));
  return (await response.json()) as T;
}

function hasEolResponseShape(value: unknown): value is EolResponse {
  return Boolean(
    value
      && typeof value === "object"
      && Array.isArray((value as EolResponse).entries)
      && typeof (value as EolResponse).truncated === "boolean"
      && typeof (value as EolResponse).limit === "number"
      && typeof (value as EolResponse).byte_limit === "number",
  );
}

function hasAttributeResponseShape(value: unknown): value is AttributeResponse {
  return Boolean(
    value
      && typeof value === "object"
      && ((value as AttributeResponse).mode === "worktree" || (value as AttributeResponse).mode === "index")
      && Array.isArray((value as AttributeResponse).entries)
      && Array.isArray((value as AttributeResponse).paths),
  );
}

function eolLabel(value: string | null | undefined) {
  if (value === null || value === undefined || value === "") return "未取得";
  if (value === "-text") return "-text（バイナリ扱い）";
  if (value === "?") return "?（Gitの値）";
  if (value === "none") return "none";
  return value;
}

function statusLabel(entry: EolEntry) {
  if (entry.eol_status === "mixed") return "混在";
  if (entry.eol_status === "unknown") return "不明";
  if (entry.eol_status === "different") return "index / worktree 差異";
  return "一致";
}

function attributeValueLabel(value: string | null, present: boolean) {
  return present ? value ?? "（空の値）" : "未指定（--all に記録なし）";
}

export default function FileAttributes({ path }: FileAttributesProps) {
  const [inventory, setInventory] = useState<EolResponse | null>(null);
  const [inventoryState, setInventoryState] = useState<LoadState>("idle");
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState("");
  const [directory, setDirectory] = useState(FILE_ATTRIBUTES_DIRECTORY_ALL);
  const [eolFilter, setEolFilter] = useState<EolFilter>(EOL_FILTER_ALL);
  const [order, setOrder] = useState<"asc" | "desc">("asc");
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [attributeMode, setAttributeMode] = useState<AttributeMode>("worktree");
  const [attributeResult, setAttributeResult] = useState<AttributeResponse | null>(null);
  const [attributeState, setAttributeState] = useState<LoadState>("idle");
  const [attributeError, setAttributeError] = useState<string | null>(null);
  const [compareLeft, setCompareLeft] = useState("");
  const [compareRight, setCompareRight] = useState("");
  const [downloadStatus, setDownloadStatus] = useState<"idle" | "success" | "error">("idle");
  const attributeController = useRef<AbortController | null>(null);
  const attributeRequestKey = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setInventoryState("loading");
    setInventoryError(null);
    void getJson<unknown>(`/api/repo/eol?${fileAttributesEolQuery(path)}`, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        if (!hasEolResponseShape(value)) throw new Error("改行調査の応答形式が不正です");
        setInventory(value);
        setInventoryState("ready");
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setInventoryError(reason instanceof Error ? reason.message : "unknown error");
        setInventoryState("error");
      });
    return () => controller.abort();
  }, [path, reload]);

  useEffect(() => {
    attributeController.current?.abort();
    attributeController.current = null;
    attributeRequestKey.current = null;
    setQuery("");
    setDirectory(FILE_ATTRIBUTES_DIRECTORY_ALL);
    setEolFilter(EOL_FILTER_ALL);
    setOrder("asc");
    setSelectedPaths([]);
    setAttributeResult(null);
    setAttributeState("idle");
    setAttributeError(null);
    setCompareLeft("");
    setCompareRight("");
    setDownloadStatus("idle");
    return () => {
      attributeController.current?.abort();
      attributeRequestKey.current = null;
    };
  }, [path]);

  const entries = inventory?.entries ?? [];
  const directories = useMemo(() => listFileAttributeDirectories(entries), [entries]);
  const visible = useMemo(() => sortFileAttributeEntries(
    filterFileAttributeEntries(entries, { query, directory, eol: eolFilter }),
    order,
  ), [directory, entries, eolFilter, order, query]);
  const filteredCounts = useMemo(() => Object.fromEntries(
    EOL_FILTERS.map((item) => [
      item.key,
      filterFileAttributeEntries(entries, { query, directory, eol: item.key }).length,
    ]),
  ), [directory, entries, query]);

  const inspectedEntries = attributeResult?.entries ?? [];
  const compareResult = useMemo(() => {
    if (!compareLeft || !compareRight || compareLeft === compareRight) return null;
    const left = attributesForPath(inspectedEntries, compareLeft);
    const right = attributesForPath(inspectedEntries, compareRight);
    return left && right ? compareFileAttributes(left, right) : null;
  }, [compareLeft, compareRight, inspectedEntries]);

  const invalidateAttributeRequest = () => {
    attributeController.current?.abort();
    attributeController.current = null;
    attributeRequestKey.current = null;
    setAttributeResult(null);
    setAttributeState("idle");
    setAttributeError(null);
    setCompareLeft("");
    setCompareRight("");
  };

  useEffect(() => {
    if (attributeResult === null) return;
    const paths = inspectedEntries.map((entry) => entry.path);
    setCompareLeft((current) => paths.includes(current) ? current : "");
    setCompareRight((current) => paths.includes(current) ? current : "");
  }, [attributeResult, inspectedEntries]);

  const inspectSelected = () => {
    if (selectedPaths.length === 0) return;
    attributeController.current?.abort();
    const controller = new AbortController();
    const selectedSnapshot = [...selectedPaths];
    const modeSnapshot = attributeMode;
    const requestKey = JSON.stringify([path, modeSnapshot, selectedSnapshot]);
    attributeController.current = controller;
    attributeRequestKey.current = requestKey;
    setAttributeState("loading");
    setAttributeError(null);
    const body = fileAttributesRequestBody(path, selectedSnapshot, modeSnapshot);
    void fetch("/api/repo/attributes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      signal: controller.signal,
      body: JSON.stringify(body),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseError(response));
        return (await response.json()) as unknown;
      })
      .then((value) => {
        if (controller.signal.aborted || attributeRequestKey.current !== requestKey) return;
        if (!hasAttributeResponseShape(value)) throw new Error("Git属性調査の応答形式が不正です");
        if (
          value.mode !== modeSnapshot
          || value.paths.length !== selectedSnapshot.length
          || value.paths.some((item, index) => item !== selectedSnapshot[index])
        ) {
          throw new Error("Git属性調査の対象が現在の選択と一致しません");
        }
        attributeController.current = null;
        setAttributeResult(value);
        setAttributeState("ready");
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || attributeRequestKey.current !== requestKey) return;
        attributeController.current = null;
        setAttributeError(reason instanceof Error ? reason.message : "unknown error");
        setAttributeState("error");
      });
  };

  const togglePath = (filePath: string) => {
    invalidateAttributeRequest();
    setSelectedPaths((current) => {
      if (current.includes(filePath)) return current.filter((value) => value !== filePath);
      if (current.length >= 100) return current;
      return [...current, filePath];
    });
  };

  const exportCsv = () => {
    setDownloadStatus("idle");
    try {
      const csv = fileAttributesCsv(visible, inspectedEntries, attributeResult?.mode ?? null);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "gitdash-file-attributes.csv";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDownloadStatus("success");
    } catch {
      setDownloadStatus("error");
    }
  };

  return (
    <details className="file-attributes" open>
      <summary>改行とGit属性を調べる</summary>
      <section aria-busy={inventoryState === "loading"} aria-labelledby="file-attributes-title">
        <div className="file-attributes-heading">
          <div>
            <h3 id="file-attributes-title">追跡ファイルの改行と属性</h3>
            <p>Gitが報告した index / 作業ツリーの改行情報と、選択したパスの有効属性を表示します。</p>
          </div>
          <button type="button" className="file-attributes-refresh" onClick={() => setReload((value) => value + 1)} disabled={inventoryState === "loading"}>再取得</button>
        </div>
        {inventoryState === "loading" && <div className="file-attributes-status" role="status">改行情報を取得中…</div>}
        {inventoryState === "error" && <div className="file-attributes-error" role="alert">改行情報を取得できませんでした。<button type="button" onClick={() => setReload((value) => value + 1)}>再取得</button>{inventoryError && <span className="sr-only">{inventoryError}</span>}</div>}
        {inventory && (
          <>
            <div className="file-attributes-controls" aria-label="改行情報の表示条件">
              <label className="file-attributes-search"><span>ファイルを検索</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="パスで検索" aria-label="改行情報のファイルを検索" /></label>
              <label><span>ディレクトリ</span><select value={directory} onChange={(event) => setDirectory(event.target.value)} aria-label="改行情報をディレクトリで絞り込み"><option value={FILE_ATTRIBUTES_DIRECTORY_ALL}>すべて</option>{directories.map((item) => <option value={item} key={item}>{item === FILE_ATTRIBUTES_DIRECTORY_ROOT ? "ルート" : item}</option>)}</select></label>
              <label><span>改行の見方</span><select value={eolFilter} onChange={(event) => setEolFilter(event.target.value as EolFilter)} aria-label="改行情報のフィルター">{EOL_FILTERS.map((item) => <option key={item.key} value={item.key}>{item.label} ({filteredCounts[item.key] ?? 0})</option>)}</select></label>
              <button type="button" className="file-attributes-order" onClick={() => setOrder((value) => value === "asc" ? "desc" : "asc")} aria-label={`パス順を${order === "asc" ? "降順" : "昇順"}に変更`}>パス順 {order === "asc" ? "↑" : "↓"}</button>
            </div>
            <div className="file-attributes-summary" role="status"><span>{visible.length} / {entries.length} ファイル</span><span>属性調査の選択 {selectedPaths.length} / 100</span><button type="button" onClick={exportCsv} disabled={visible.length === 0}>現在の一覧をCSV保存</button>{downloadStatus === "success" && <span>CSVの保存を開始しました。</span>}{downloadStatus === "error" && <span role="alert">CSVを保存できませんでした。</span>}</div>
            {inventory.truncated && <div className="file-attributes-note" role="status">Gitの一覧は {inventory.limit} 件までです。表示されていない追跡ファイルはこの調査に含まれません。</div>}
            <div className="file-attributes-table-wrap">
              <table className="file-attributes-table">
                <thead><tr><th scope="col">調査</th><th scope="col">パス</th><th scope="col">index</th><th scope="col">作業ツリー</th><th scope="col">属性の eol</th><th scope="col">観測</th><th scope="col">ls-files の属性欄</th></tr></thead>
                <tbody>
                  {visible.map((entry) => {
                    const checked = selectedPaths.includes(entry.path);
                    const disabled = !checked && selectedPaths.length >= 100;
                    return <tr key={entry.path}><td><input type="checkbox" checked={checked} disabled={disabled} onChange={() => togglePath(entry.path)} aria-label={`${entry.path}を属性調査に含める`} /></td><th scope="row"><code title={entry.path}>{entry.path}</code></th><td><code>{eolLabel(entry.index_eol)}</code></td><td><code>{eolLabel(entry.worktree_eol)}</code></td><td><code>{eolLabel(entry.attribute_eol)}</code></td><td><span className={`file-attributes-observation observation-${entry.eol_status}`}>{statusLabel(entry)}</span>{entry.flags.length > 0 && <span className="file-attributes-flags">{entry.flags.join(" · ")}</span>}</td><td><code>{entry.attributes || "（属性欄なし）"}</code></td></tr>;
                  })}
                  {visible.length === 0 && <tr><td colSpan={7} className="file-attributes-empty">条件に一致する追跡ファイルはありません。</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="file-attributes-inspection" aria-labelledby="file-attributes-inspection-title">
              <div className="file-attributes-inspection-heading"><div><h4 id="file-attributes-inspection-title">選択したファイルの有効属性</h4><p>属性名が返らなかったパスは「未指定」と表示します。値を他のパスやモードから補いません。</p></div><div className="file-attributes-inspection-controls"><label><span>評価対象</span><select value={attributeMode} onChange={(event) => { invalidateAttributeRequest(); setAttributeMode(event.target.value as AttributeMode); }} aria-label="Git属性を評価する対象">{FILE_ATTRIBUTE_MODES.map((mode) => <option value={mode} key={mode}>{mode === "worktree" ? "作業ツリー" : "index（ステージ）"}</option>)}</select></label><button type="button" onClick={inspectSelected} disabled={selectedPaths.length === 0 || attributeState === "loading"}>{attributeState === "loading" ? "属性を取得中…" : `選択した ${selectedPaths.length} 件を調べる`}</button></div></div>
              {attributeState === "error" && <div className="file-attributes-error" role="alert">Git属性を取得できませんでした。<button type="button" onClick={inspectSelected} disabled={selectedPaths.length === 0}>再取得</button>{attributeError && <span className="sr-only">{attributeError}</span>}</div>}
              {attributeState === "loading" && <div className="file-attributes-status" role="status">{attributeMode === "worktree" ? "作業ツリー" : "index（ステージ）"}の属性を取得中…</div>}
              {attributeResult && attributeState !== "loading" && <>
                <div className="file-attributes-inspection-meta" role="status">{attributeResult.entries.length} 件 · {attributeResult.mode === "worktree" ? "作業ツリー" : "index（ステージ）"}{attributeResult.command && <code>{attributeResult.command}</code>}</div>
                <div className="file-attributes-attribute-list">{attributeResult.entries.map((entry) => <div className="file-attributes-attribute-card" key={entry.path}><code>{entry.path}</code>{Object.keys(entry.attributes).length === 0 ? <span>--all に記録された属性はありません。</span> : <dl>{Object.entries(entry.attributes).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => <div key={name}><dt>{name}</dt><dd><code>{value}</code></dd></div>)}</dl>}</div>)}</div>
                {attributeResult.entries.length >= 2 && <div className="file-attributes-compare"><h5>2つのパスの属性を比較</h5><div className="file-attributes-compare-controls"><label><span>左</span><select value={compareLeft} onChange={(event) => setCompareLeft(event.target.value)}><option value="">選択してください</option>{attributeResult.entries.map((entry) => <option value={entry.path} key={`left-${entry.path}`}>{entry.path}</option>)}</select></label><label><span>右</span><select value={compareRight} onChange={(event) => setCompareRight(event.target.value)}><option value="">選択してください</option>{attributeResult.entries.map((entry) => <option value={entry.path} key={`right-${entry.path}`}>{entry.path}</option>)}</select></label></div>{compareResult && <div className="file-attributes-compare-result"><p>{compareResult.identical ? "--all が返した属性名と値は同じです。" : `差異 ${compareResult.differences.length} 件。未指定は --all に記録がなかった事実です。`}</p><table><thead><tr><th scope="col">属性</th><th scope="col">{compareResult.leftPath}</th><th scope="col">{compareResult.rightPath}</th></tr></thead><tbody>{compareResult.rows.map((row) => <tr key={row.name} className={row.same ? "is-same" : "is-different"}><th scope="row"><code>{row.name}</code></th><td>{attributeValueLabel(row.left, row.leftPresent)}</td><td>{attributeValueLabel(row.right, row.rightPresent)}</td></tr>)}</tbody></table></div>}</div>}
              </>}
            </div>
          </>
        )}
      </section>
    </details>
  );
}

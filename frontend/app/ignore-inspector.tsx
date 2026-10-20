"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  IGNORE_DIRECTORY_ALL,
  IGNORE_DIRECTORY_ROOT,
  IGNORE_PATH_LIMIT,
  checkIgnorePayload,
  filterIgnoreEntriesByDirectory,
  ignoreEntriesCsv,
  ignoreEntryDirectory,
  ignoreEntryStatus,
  listIgnoreDirectories,
  parseIgnoreCandidates,
  searchIgnoreEntries,
  sortIgnoreEntries,
} from "./ignore-inspector-tools.mjs";
import "./ignore-inspector.css";

type IgnoreEntry = {
  path: string;
  ignored: boolean;
  tracked: boolean;
  source: string | null;
  line: number | null;
  pattern: string | null;
  negation: boolean | null;
};

type InventoryResponse = {
  entries: IgnoreEntry[];
  count: number;
  truncated: boolean;
  entry_limit: number;
  byte_limit: number;
};

type CheckResponse = {
  results: IgnoreEntry[];
  count: number;
  path_limit: number;
};

type LoadState = "idle" | "loading" | "ready" | "error";

async function responseError(response: Response) {
  try {
    const body = await response.json() as { detail?: unknown };
    if (typeof body.detail === "string" && body.detail) return body.detail;
  } catch {
    // The status remains useful when the proxy returns a non-JSON error.
  }
  return `HTTP ${response.status}`;
}

function formatRule(entry: IgnoreEntry) {
  if (!entry.source || entry.line === null) return "ルール情報未取得";
  return `${entry.source}:${entry.line}`;
}

function formatPattern(entry: IgnoreEntry) {
  if (entry.pattern === null) return "ルールなし";
  if (entry.negation === true) return `否定 ${entry.pattern}`;
  return entry.pattern;
}

function downloadEntries(entries: IgnoreEntry[], name: string, setStatus: (value: string) => void) {
  if (entries.length === 0) return;
  try {
    const url = URL.createObjectURL(new Blob([ignoreEntriesCsv(entries)], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(`${entries.length}件のCSV保存を開始しました。`);
  } catch {
    setStatus("CSVを保存できませんでした。");
  }
}

function EntryTable({ entries, empty }: { entries: IgnoreEntry[]; empty: string }) {
  if (entries.length === 0) return <p className="ignore-inspector-empty">{empty}</p>;
  return <div className="ignore-inspector-table-wrap">
    <table className="ignore-inspector-table">
      <thead><tr><th scope="col">パス</th><th scope="col">判定</th><th scope="col">ルール</th><th scope="col">パターン</th></tr></thead>
      <tbody>{entries.map((entry, index) => <tr key={`${entry.path}\u0000${index}`}>
        <td><code className="ignore-inspector-path">{entry.path}</code></td>
        <td><span className={`ignore-inspector-state${entry.negation === true ? " is-negation" : ""}`}>{ignoreEntryStatus(entry)}</span></td>
        <td><code className="ignore-inspector-source">{formatRule(entry)}</code></td>
        <td><code className="ignore-inspector-pattern">{formatPattern(entry)}</code></td>
      </tr>)}</tbody>
    </table>
  </div>;
}

export default function IgnoreInspector({ path }: { path: string }) {
  const [open, setOpen] = useState(false);
  const [inventoryState, setInventoryState] = useState<LoadState>("idle");
  const [inventory, setInventory] = useState<InventoryResponse | null>(null);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [inventoryQuery, setInventoryQuery] = useState("");
  const [inventoryDirectory, setInventoryDirectory] = useState(IGNORE_DIRECTORY_ALL);
  const [inventoryOrder, setInventoryOrder] = useState("asc");
  const [inventoryExportStatus, setInventoryExportStatus] = useState("");
  const [candidates, setCandidates] = useState("");
  const [checkState, setCheckState] = useState<LoadState>("idle");
  const [checkResult, setCheckResult] = useState<CheckResponse | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checkExportStatus, setCheckExportStatus] = useState("");
  const inventoryControllerRef = useRef<AbortController | null>(null);
  const checkControllerRef = useRef<AbortController | null>(null);
  const inventoryKeyRef = useRef<string | null>(null);
  const checkKeyRef = useRef<string | null>(null);
  const requestSequenceRef = useRef(0);

  useEffect(() => {
    inventoryControllerRef.current?.abort();
    checkControllerRef.current?.abort();
    inventoryControllerRef.current = null;
    checkControllerRef.current = null;
    inventoryKeyRef.current = null;
    checkKeyRef.current = null;
    setInventoryState("idle");
    setInventory(null);
    setInventoryError(null);
    setInventoryQuery("");
    setInventoryDirectory(IGNORE_DIRECTORY_ALL);
    setInventoryOrder("asc");
    setInventoryExportStatus("");
    setCandidates("");
    setCheckState("idle");
    setCheckResult(null);
    setCheckError(null);
    setCheckExportStatus("");
    return () => {
      inventoryControllerRef.current?.abort();
      checkControllerRef.current?.abort();
      inventoryControllerRef.current = null;
      checkControllerRef.current = null;
      inventoryKeyRef.current = null;
      checkKeyRef.current = null;
    };
  }, [path]);

  const inventoryDirectories = useMemo(
    () => inventory ? listIgnoreDirectories(inventory.entries) : [],
    [inventory],
  );
  const visibleInventory = useMemo(() => {
    if (!inventory) return [];
    const searched = searchIgnoreEntries(inventory.entries, inventoryQuery);
    return sortIgnoreEntries(filterIgnoreEntriesByDirectory(searched, inventoryDirectory), inventoryOrder);
  }, [inventory, inventoryDirectory, inventoryOrder, inventoryQuery]);

  const loadInventory = () => {
    inventoryControllerRef.current?.abort();
    const controller = new AbortController();
    const requestKey = `${path}:inventory:${++requestSequenceRef.current}`;
    inventoryControllerRef.current = controller;
    inventoryKeyRef.current = requestKey;
    setInventoryState("loading");
    setInventoryError(null);
    setInventoryExportStatus("");
    void fetch(`/api/repo/ignored?path=${encodeURIComponent(path)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseError(response));
        return await response.json() as InventoryResponse;
      })
      .then((value) => {
        if (controller.signal.aborted || inventoryKeyRef.current !== requestKey) return;
        if (!Array.isArray(value.entries) || typeof value.truncated !== "boolean") throw new Error("応答形式を確認できません");
        setInventory(value);
        setInventoryState("ready");
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted || inventoryKeyRef.current !== requestKey) return;
        setInventoryError(caught instanceof Error ? caught.message : "unknown error");
        setInventoryState("error");
      })
      .finally(() => {
        if (inventoryControllerRef.current === controller && inventoryKeyRef.current === requestKey) {
          inventoryControllerRef.current = null;
        }
      });
  };

  const runCheck = () => {
    checkControllerRef.current?.abort();
    checkControllerRef.current = null;
    checkKeyRef.current = `${path}:check-input:${++requestSequenceRef.current}`;
    let paths: string[];
    let payload: { path: string; paths: string[] };
    try {
      paths = parseIgnoreCandidates(candidates) as string[];
      payload = checkIgnorePayload(path, paths) as { path: string; paths: string[] };
    } catch (caught: unknown) {
      setCheckError(caught instanceof Error ? caught.message : "候補パスを確認してください。");
      setCheckState("error");
      return;
    }
    const controller = new AbortController();
    const requestKey = `${path}:check:${++requestSequenceRef.current}:${paths.join("\u0000")}`;
    checkControllerRef.current = controller;
    checkKeyRef.current = requestKey;
    setCheckState("loading");
    setCheckError(null);
    setCheckExportStatus("");
    void fetch("/api/repo/check-ignore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseError(response));
        return await response.json() as CheckResponse;
      })
      .then((value) => {
        if (controller.signal.aborted || checkKeyRef.current !== requestKey) return;
        if (!Array.isArray(value.results)) throw new Error("応答形式を確認できません");
        setCheckResult(value);
        setCheckState("ready");
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted || checkKeyRef.current !== requestKey) return;
        setCheckError(caught instanceof Error ? caught.message : "unknown error");
        setCheckState("error");
      })
      .finally(() => {
        if (checkControllerRef.current === controller && checkKeyRef.current === requestKey) {
          checkControllerRef.current = null;
        }
      });
  };

  const inventoryHasFilters = inventoryQuery.trim() !== "" || inventoryDirectory !== IGNORE_DIRECTORY_ALL || inventoryOrder !== "asc";
  const clearInventoryFilters = () => {
    setInventoryQuery("");
    setInventoryDirectory(IGNORE_DIRECTORY_ALL);
    setInventoryOrder("asc");
  };

  return <details className="ignore-inspector" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary id="ignore-inspector-title">無視されるファイルと理由を調べる <span>一覧・候補判定・CSV</span></summary>
    <div className="ignore-inspector-body">
      <div className="ignore-inspector-heading">
        <div>
          <h3>Gitのignoreルールを確認</h3>
          <p>作業ツリーの無視済み一覧と、指定した候補パスの最終ルールを別々に取得します。ファイルの内容は読み取りません。</p>
        </div>
        <code className="ignore-inspector-repo" title={path}>{path}</code>
      </div>

      <section className="ignore-inspector-section" aria-labelledby="ignore-inventory-title" aria-busy={inventoryState === "loading"}>
        <div className="ignore-inspector-section-heading"><div><h4 id="ignore-inventory-title">無視済みファイル一覧</h4><p>未追跡かつGitが無視しているパスを、最大1,000件・1MiBまで表示します。</p></div><button type="button" className="primary-action" disabled={inventoryState === "loading"} onClick={loadInventory}>{inventoryState === "loading" ? "一覧を取得中…" : inventoryState === "idle" ? "一覧を取得" : "一覧を再取得"}</button></div>
        {inventoryState === "error" && <p className="ignore-inspector-error" role="alert">無視済みファイル一覧を取得できませんでした。{inventoryError && <span>（{inventoryError}）</span>}</p>}
        {inventory && <>
          <div className="ignore-inspector-tools" role="group" aria-label="無視済みファイル一覧の絞り込み">
            <label className="ignore-inspector-search"><span>一覧を検索</span><input type="search" value={inventoryQuery} onChange={(event) => setInventoryQuery(event.target.value)} placeholder="パス・ルールを検索" aria-label="無視済みファイル一覧を検索" /></label>
            <label><span>ディレクトリ</span><select value={inventoryDirectory} onChange={(event) => setInventoryDirectory(event.target.value)} aria-label="無視済みファイル一覧をディレクトリで絞り込み"><option value={IGNORE_DIRECTORY_ALL}>すべて</option>{inventoryDirectories.map((directory) => <option key={directory} value={directory}>{directory === IGNORE_DIRECTORY_ROOT ? "ルート" : directory}</option>)}</select></label>
            <button type="button" className="ignore-inspector-order" onClick={() => setInventoryOrder((value) => value === "asc" ? "desc" : "asc")} aria-label={`パス順を${inventoryOrder === "asc" ? "降順" : "昇順"}に変更`}>{inventoryOrder === "asc" ? "パス順 ↑" : "パス順 ↓"}</button>
          </div>
          <div className="ignore-inspector-summary"><span role="status">{visibleInventory.length} / {inventory.entries.length} 件</span>{inventory.truncated && <span className="ignore-inspector-note" role="status">上限に達したため、一覧は一部です。</span>}<button type="button" className="subtle-button" disabled={visibleInventory.length === 0} onClick={() => downloadEntries(visibleInventory, "gitdash-ignored.csv", setInventoryExportStatus)}>表示中をCSV保存</button><button type="button" className="subtle-button" disabled={!inventoryHasFilters} onClick={clearInventoryFilters}>絞り込みを解除</button><span className="ignore-inspector-download" role="status" aria-live="polite">{inventoryExportStatus}</span></div>
          <EntryTable entries={visibleInventory} empty={inventory.entries.length === 0 ? "無視されている未追跡ファイルはありません。" : "条件に一致するファイルはありません。"} />
        </>}
      </section>

      <section className="ignore-inspector-section" aria-labelledby="ignore-check-title" aria-busy={checkState === "loading"}>
        <div className="ignore-inspector-section-heading"><div><h4 id="ignore-check-title">候補パスのルール判定</h4><p>1行に1パス、最大{IGNORE_PATH_LIMIT}件です。追跡済みでもルールが適用されるかを判定します。</p></div></div>
        <label className="ignore-inspector-candidates"><span>候補パス（リポジトリ相対）</span><textarea value={candidates} onChange={(event) => setCandidates(event.target.value)} rows={5} placeholder={"cache/generated.txt\nsrc/secret note.tmp\nkeep.log"} aria-label="ignoreルールを調べる候補パス" /></label>
        <div className="ignore-inspector-check-actions"><button type="button" className="primary-action" disabled={checkState === "loading"} onClick={runCheck}>{checkState === "loading" ? "判定中…" : "候補を判定"}</button><span className="ignore-inspector-input-note">空行は区切りとして扱います。パスの空白は保持します。</span></div>
        {checkState === "error" && <p className="ignore-inspector-error" role="alert">候補パスを判定できませんでした。{checkError && <span>（{checkError}）</span>}</p>}
        {checkResult && <>
          <div className="ignore-inspector-summary"><span role="status">{checkResult.results.length} 件</span><button type="button" className="subtle-button" disabled={checkResult.results.length === 0} onClick={() => downloadEntries(checkResult.results, "gitdash-ignore-diagnosis.csv", setCheckExportStatus)}>判定をCSV保存</button><span className="ignore-inspector-download" role="status" aria-live="polite">{checkExportStatus}</span></div>
          <EntryTable entries={checkResult.results} empty="候補パスはありません。" />
        </>}
      </section>
    </div>
  </details>;
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  IGNORE_DIRECTORY_ALL,
  IGNORE_DIRECTORY_ROOT,
  IGNORE_PAGE_SIZES,
  IGNORE_PATH_LIMIT,
  checkIgnorePayload,
  deduplicateIgnoreCandidates,
  filterIgnoreEntriesByDirectory,
  filterIgnoreEntriesByOutcome,
  filterIgnoreEntriesByRule,
  filterIgnoreEntriesBySource,
  ignoreCandidatesMatchResult,
  ignoreEntriesCandidateText,
  ignoreEntriesCsv,
  ignoreEntriesReport,
  ignoreEntryStatus,
  inspectIgnoreCandidates,
  listIgnoreDirectories,
  listIgnoreSources,
  paginateIgnoreEntries,
  parseIgnoreCandidates,
  searchIgnoreEntries,
  sortIgnoreEntries,
  summarizeIgnoreOutcomes,
  summarizeIgnoreRules,
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

type RuleGroup = Pick<IgnoreEntry, "source" | "line" | "pattern" | "negation"> & { key: string; count: number };
type ReportContext = {
  repository: string;
  scope: string;
  filters: string[];
  inventoryTruncated: boolean | null;
  inputCurrent: boolean | null;
};
type LoadState = "idle" | "loading" | "ready" | "error";
type Outcome = "all" | "ignored" | "tracked" | "negation" | "unmatched";

const OUTCOME_LABELS: { value: Outcome; label: string }[] = [
  { value: "all", label: "すべて" },
  { value: "ignored", label: "無視される" },
  { value: "tracked", label: "追跡済みの一致" },
  { value: "negation", label: "否定ルール" },
  { value: "unmatched", label: "ルールなし" },
];

function outcomeLabel(outcome: Outcome) {
  const option = OUTCOME_LABELS.find((item) => item.value === outcome);
  if (option === undefined) throw new RangeError("Unknown ignore outcome");
  return option.label;
}

async function responseError(response: Response) {
  try {
    const body = await response.json() as { detail?: unknown };
    if (typeof body.detail === "string" && body.detail) return body.detail;
  } catch {
    // The status remains useful when the proxy returns a non-JSON error.
  }
  return "HTTP " + response.status;
}

function formatRule(entry: Pick<IgnoreEntry, "source" | "line">) {
  if (entry.source === null || entry.line === null) return "ルール情報未取得";
  return entry.source + ":" + entry.line;
}

function formatPattern(entry: Pick<IgnoreEntry, "pattern" | "negation">) {
  if (entry.pattern === null) return "ルールなし";
  if (entry.negation === true) return "否定 " + entry.pattern;
  return entry.pattern;
}

function sourceLabel(source: string | null) {
  return source === null ? "ルール元情報なし" : source;
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
    setStatus(entries.length + "件のCSV保存を開始しました。");
  } catch {
    setStatus("CSVを保存できませんでした。");
  }
}

async function copyReport(entries: IgnoreEntry[], context: ReportContext, setStatus: (value: string) => void) {
  try {
    await navigator.clipboard.writeText(ignoreEntriesReport(entries, context));
    setStatus(entries.length + "件の調査レポートをコピーしました。");
  } catch {
    setStatus("レポートをコピーできませんでした。ブラウザのクリップボード権限を確認してください。");
  }
}

function EntryTable({ entries, empty, label, selection }: {
  entries: IgnoreEntry[];
  empty: string;
  label: string;
  selection: { paths: string[]; onToggle: (path: string) => void } | null;
}) {
  if (entries.length === 0) return <p className="ignore-inspector-empty">{empty}</p>;
  const selected = new Set(selection === null ? [] : selection.paths);
  return <div className="ignore-inspector-table-wrap">
    <table className="ignore-inspector-table">
      <caption className="ignore-inspector-sr-only">{label}</caption>
      <thead><tr>{selection !== null && <th scope="col"><span className="ignore-inspector-sr-only">選択</span></th>}<th scope="col">パス</th><th scope="col">判定</th><th scope="col">ルール</th><th scope="col">パターン</th></tr></thead>
      <tbody>{entries.map((entry, index) => <tr key={entry.path + "\u0000" + index} className={selected.has(entry.path) ? "is-selected" : undefined}>
        {selection !== null && <td className="ignore-inspector-select-cell"><input type="checkbox" checked={selected.has(entry.path)} onChange={() => selection.onToggle(entry.path)} aria-label={entry.path + " を選択"} /></td>}
        <td><code className="ignore-inspector-path">{entry.path}</code></td>
        <td><span className={"ignore-inspector-state" + (entry.negation === true ? " is-negation" : "")}>{ignoreEntryStatus(entry)}</span></td>
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
  const [inventorySourceKey, setInventorySourceKey] = useState<string | null>(null);
  const [inventoryRule, setInventoryRule] = useState<RuleGroup | null>(null);
  const [inventoryOrder, setInventoryOrder] = useState("asc");
  const [inventoryPage, setInventoryPage] = useState(1);
  const [inventoryPageSize, setInventoryPageSize] = useState(25);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [inventoryExportStatus, setInventoryExportStatus] = useState("");
  const [candidates, setCandidates] = useState("");
  const [candidateEditStatus, setCandidateEditStatus] = useState("");
  const [checkState, setCheckState] = useState<LoadState>("idle");
  const [checkResult, setCheckResult] = useState<CheckResponse | null>(null);
  const [checkedPaths, setCheckedPaths] = useState<string[] | null>(null);
  const [checkOutcome, setCheckOutcome] = useState<Outcome>("all");
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checkExportStatus, setCheckExportStatus] = useState("");
  const inventoryControllerRef = useRef<AbortController | null>(null);
  const checkControllerRef = useRef<AbortController | null>(null);
  const inventoryKeyRef = useRef<string | null>(null);
  const checkKeyRef = useRef<string | null>(null);
  const requestSequenceRef = useRef(0);
  const candidatesRef = useRef<HTMLTextAreaElement | null>(null);

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
    setInventorySourceKey(null);
    setInventoryRule(null);
    setInventoryOrder("asc");
    setInventoryPage(1);
    setInventoryPageSize(25);
    setSelectedPaths([]);
    setInventoryExportStatus("");
    setCandidates("");
    setCandidateEditStatus("");
    setCheckState("idle");
    setCheckResult(null);
    setCheckedPaths(null);
    setCheckOutcome("all");
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
    () => inventory ? listIgnoreDirectories(inventory.entries) as string[] : [],
    [inventory],
  );
  const inventorySources = useMemo(
    () => inventory ? listIgnoreSources(inventory.entries) as { source: string | null; count: number }[] : [],
    [inventory],
  );
  const inventoryBeforeRule = useMemo(() => {
    if (!inventory) return [];
    const searched = searchIgnoreEntries(inventory.entries, inventoryQuery) as IgnoreEntry[];
    const byDirectory = filterIgnoreEntriesByDirectory(searched, inventoryDirectory) as IgnoreEntry[];
    return inventorySourceKey === null ? byDirectory : filterIgnoreEntriesBySource(byDirectory, JSON.parse(inventorySourceKey)) as IgnoreEntry[];
  }, [inventory, inventoryDirectory, inventoryQuery, inventorySourceKey]);
  const inventoryRules = useMemo(() => summarizeIgnoreRules(inventoryBeforeRule) as RuleGroup[], [inventoryBeforeRule]);
  const visibleInventory = useMemo(() => {
    const byRule = inventoryRule === null ? inventoryBeforeRule : filterIgnoreEntriesByRule(inventoryBeforeRule, inventoryRule.key) as IgnoreEntry[];
    return sortIgnoreEntries(byRule, inventoryOrder) as IgnoreEntry[];
  }, [inventoryBeforeRule, inventoryOrder, inventoryRule]);
  const inventoryPagination = useMemo(
    () => paginateIgnoreEntries(visibleInventory, inventoryPage, inventoryPageSize) as { entries: IgnoreEntry[]; page: number; pageCount: number; start: number; end: number; total: number },
    [visibleInventory, inventoryPage, inventoryPageSize],
  );
  const selectedInventory = useMemo(
    () => inventory === null ? [] : inventory.entries.filter((entry) => selectedPaths.includes(entry.path)),
    [inventory, selectedPaths],
  );
  const selectedCandidateText = useMemo(() => {
    if (selectedInventory.length === 0) return { value: null, error: null };
    try {
      return { value: ignoreEntriesCandidateText(selectedInventory) as string, error: null };
    } catch (caught: unknown) {
      return { value: null, error: caught instanceof Error ? caught.message : "選択したパスを確認してください。" };
    }
  }, [selectedInventory]);
  const selectedOutsideFilter = selectedInventory.filter((entry) => !visibleInventory.some((visible) => visible.path === entry.path)).length;
  const pageSelected = inventoryPagination.entries.length > 0 && inventoryPagination.entries.every((entry) => selectedPaths.includes(entry.path));
  const candidateInfo = useMemo(() => inspectIgnoreCandidates(candidates) as { count: number; uniqueCount: number; duplicateCount: number; error: string | null }, [candidates]);
  const checkInputCurrent = checkedPaths !== null && ignoreCandidatesMatchResult(candidates, checkedPaths);
  const checkCounts = useMemo(() => summarizeIgnoreOutcomes(checkResult === null ? [] : checkResult.results) as Record<Outcome, number>, [checkResult]);
  const visibleCheck = useMemo(() => checkResult === null ? [] : filterIgnoreEntriesByOutcome(checkResult.results, checkOutcome) as IgnoreEntry[], [checkResult, checkOutcome]);

  const loadInventory = () => {
    inventoryControllerRef.current?.abort();
    const controller = new AbortController();
    const requestKey = path + ":inventory:" + ++requestSequenceRef.current;
    inventoryControllerRef.current = controller;
    inventoryKeyRef.current = requestKey;
    setInventoryState("loading");
    setInventoryError(null);
    setInventoryExportStatus("");
    void fetch("/api/repo/ignored?path=" + encodeURIComponent(path), { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseError(response));
        return await response.json() as InventoryResponse;
      })
      .then((value) => {
        if (controller.signal.aborted || inventoryKeyRef.current !== requestKey) return;
        if (!Array.isArray(value.entries) || typeof value.truncated !== "boolean") throw new Error("応答形式を確認できません");
        setInventoryPage(1);
        setSelectedPaths((current) => current.filter((selected) => value.entries.some((entry) => entry.path === selected)));
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
    checkKeyRef.current = path + ":check-input:" + ++requestSequenceRef.current;
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
    const requestKey = path + ":check:" + ++requestSequenceRef.current + ":" + paths.join("\u0000");
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
        setCheckedPaths(paths);
        setCheckOutcome("all");
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

  const inventoryHasFilters = inventoryQuery.trim() !== "" || inventoryDirectory !== IGNORE_DIRECTORY_ALL || inventorySourceKey !== null || inventoryRule !== null || inventoryOrder !== "asc";
  const clearInventoryFilters = () => {
    setInventoryQuery("");
    setInventoryDirectory(IGNORE_DIRECTORY_ALL);
    setInventorySourceKey(null);
    setInventoryRule(null);
    setInventoryOrder("asc");
    setInventoryPage(1);
  };
  const toggleSelectedPath = (selected: string) => {
    setSelectedPaths((current) => current.includes(selected) ? current.filter((item) => item !== selected) : [...current, selected]);
  };
  const togglePageSelection = () => {
    const pagePaths = new Set(inventoryPagination.entries.map((entry) => entry.path));
    setSelectedPaths((current) => pageSelected ? current.filter((selected) => !pagePaths.has(selected)) : [...new Set([...current, ...pagePaths])]);
  };
  const inventoryReportContext = (): ReportContext => ({
    repository: path,
    scope: selectedInventory.length > 0 ? "一覧から選択したパス" : "無視済み一覧の絞り込み結果（全ページ）",
    filters: selectedInventory.length > 0 ? ["選択したパス。現在の絞り込み外の選択も含みます。"] : [
      "検索: " + (inventoryQuery.trim() === "" ? "すべて" : inventoryQuery),
      "ディレクトリ: " + (inventoryDirectory === IGNORE_DIRECTORY_ALL ? "すべて" : inventoryDirectory),
      "ルール元: " + (inventorySourceKey === null ? "すべて" : sourceLabel(JSON.parse(inventorySourceKey) as string | null)),
      "ルール: " + (inventoryRule === null ? "すべて" : formatRule(inventoryRule) + " " + formatPattern(inventoryRule)),
      "パス順: " + (inventoryOrder === "asc" ? "昇順" : "降順"),
    ],
    inventoryTruncated: inventory === null ? null : inventory.truncated,
    inputCurrent: null,
  });

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
        {inventoryState === "error" && <p className="ignore-inspector-error" role="alert">無視済みファイル一覧を取得できませんでした。{inventoryError && <span>（{inventoryError}）</span>}{inventory !== null && <span>以下は前回取得した一覧です。</span>}</p>}
        {inventory && <>
          <div className="ignore-inspector-tools" role="group" aria-label="無視済みファイル一覧の絞り込み">
            <label className="ignore-inspector-search"><span>一覧を検索</span><input type="search" value={inventoryQuery} onChange={(event) => { setInventoryQuery(event.target.value); setInventoryPage(1); }} placeholder="パス・ルールを検索" aria-label="無視済みファイル一覧を検索" /></label>
            <label><span>ディレクトリ</span><select value={inventoryDirectory} onChange={(event) => { setInventoryDirectory(event.target.value); setInventoryPage(1); }} aria-label="無視済みファイル一覧をディレクトリで絞り込み"><option value={IGNORE_DIRECTORY_ALL}>すべて</option>{inventoryDirectories.map((directory) => <option key={directory} value={directory}>{directory === IGNORE_DIRECTORY_ROOT ? "ルート" : directory}</option>)}</select></label>
            <label><span>ルール元</span><select value={inventorySourceKey === null ? "" : inventorySourceKey} onChange={(event) => { setInventorySourceKey(event.target.value === "" ? null : event.target.value); setInventoryRule(null); setInventoryPage(1); }} aria-label="無視済みファイル一覧をルール元で絞り込み"><option value="">すべて</option>{inventorySources.map((item) => <option key={JSON.stringify(item.source)} value={JSON.stringify(item.source)}>{sourceLabel(item.source)}（{item.count}件）</option>)}{inventorySourceKey !== null && !inventorySources.some((item) => JSON.stringify(item.source) === inventorySourceKey) && <option value={inventorySourceKey}>{sourceLabel(JSON.parse(inventorySourceKey) as string | null)}（0件）</option>}</select></label>
            <button type="button" className="ignore-inspector-order" onClick={() => { setInventoryOrder((value) => value === "asc" ? "desc" : "asc"); setInventoryPage(1); }} aria-label={"パス順を" + (inventoryOrder === "asc" ? "降順" : "昇順") + "に変更"}>{inventoryOrder === "asc" ? "パス順 ↑" : "パス順 ↓"}</button>
          </div>
          <details className="ignore-inspector-rules">
            <summary>ルールごとの件数 <span>{inventoryRules.length}ルール・{inventoryBeforeRule.length}件</span></summary>
            <p>検索・ディレクトリ・ルール元で絞った一覧を集計します。ルールを選ぶと対象パスだけを表示します。</p>
            <div className="ignore-inspector-rule-list" role="group" aria-label="有効ルールごとの絞り込み">
              {inventoryRules.map((rule) => <button key={rule.key} type="button" aria-pressed={inventoryRule?.key === rule.key} onClick={() => { setInventoryRule((current) => current?.key === rule.key ? null : rule); setInventoryPage(1); }}><span><code>{formatRule(rule)}</code><code>{formatPattern(rule)}</code></span><strong>{rule.count}件</strong></button>)}
              {inventoryRules.length === 0 && <p className="ignore-inspector-empty">集計できるルールはありません。</p>}
            </div>
          </details>
          {inventoryRule !== null && <div className="ignore-inspector-active-rule"><span>対象ルール: <code>{formatRule(inventoryRule)} {formatPattern(inventoryRule)}</code></span><button type="button" className="subtle-button" onClick={() => { setInventoryRule(null); setInventoryPage(1); }}>ルールの絞り込みを解除</button></div>}
          <div className="ignore-inspector-summary"><span role="status">{visibleInventory.length} / {inventory.entries.length} 件</span>{inventory.truncated && <span className="ignore-inspector-note" role="status">上限に達したため、一覧は一部です。</span>}<button type="button" className="subtle-button" disabled={visibleInventory.length === 0} onClick={() => downloadEntries(visibleInventory, "gitdash-ignored.csv", setInventoryExportStatus)}>絞り込み結果をCSV保存</button><button type="button" className="subtle-button" disabled={selectedInventory.length === 0 && visibleInventory.length === 0} onClick={() => { void copyReport(selectedInventory.length > 0 ? selectedInventory : visibleInventory, inventoryReportContext(), setInventoryExportStatus); }}>{selectedInventory.length > 0 ? "選択の調査レポートをコピー" : "絞り込み結果のレポートをコピー"}</button><button type="button" className="subtle-button" disabled={!inventoryHasFilters} onClick={clearInventoryFilters}>絞り込みを解除</button></div>
          <div className="ignore-inspector-selection">
            <div className="ignore-inspector-check-actions">
              <button type="button" className="subtle-button" disabled={inventoryPagination.entries.length === 0} onClick={togglePageSelection}>{pageSelected ? "このページの選択を解除" : "このページを選択"}</button>
              <span role="status">選択 {selectedInventory.length}件{selectedOutsideFilter > 0 ? "（絞り込み外 " + selectedOutsideFilter + "件を含む）" : ""}</span>
              <button type="button" className="subtle-button" disabled={selectedCandidateText.value === null || checkState === "loading"} onClick={() => { if (selectedCandidateText.value === null) return; setCandidates(selectedCandidateText.value); setCandidateEditStatus(selectedInventory.length + "件を候補入力にセットしました。"); candidatesRef.current?.focus(); }}>選択を候補にセット</button>
              <button type="button" className="subtle-button" disabled={selectedInventory.length === 0} onClick={() => setSelectedPaths([])}>すべての選択を解除</button>
            </div>
            {selectedInventory.length > 0 && <p>{selectedCandidateText.error === null ? "候補入力を選択したパスに置き換えます（最大" + IGNORE_PATH_LIMIT + "件）。" : selectedCandidateText.error}</p>}
          </div>
          <EntryTable entries={inventoryPagination.entries} empty={inventory.entries.length === 0 ? "無視されている未追跡ファイルはありません。" : "条件に一致するファイルはありません。"} label="無視済みファイル一覧の現在のページ" selection={{ paths: selectedPaths, onToggle: toggleSelectedPath }} />
          <nav className="ignore-inspector-pagination" aria-label="無視済み一覧のページ">
            <label><span>1ページの件数</span><select value={inventoryPageSize} onChange={(event) => { setInventoryPageSize(Number(event.target.value)); setInventoryPage(1); }}>{IGNORE_PAGE_SIZES.map((size: number) => <option key={size} value={size}>{size}件</option>)}</select></label>
            <span role="status">{inventoryPagination.start}–{inventoryPagination.end} / {inventoryPagination.total}件 · {inventoryPagination.page} / {inventoryPagination.pageCount}ページ</span>
            <div><button type="button" className="subtle-button" aria-label="無視済み一覧の最初のページ" disabled={inventoryPage === 1} onClick={() => setInventoryPage(1)}>最初</button><button type="button" className="subtle-button" aria-label="無視済み一覧の前のページ" disabled={inventoryPage === 1} onClick={() => setInventoryPage((current) => current - 1)}>前へ</button><button type="button" className="subtle-button" aria-label="無視済み一覧の次のページ" disabled={inventoryPage === inventoryPagination.pageCount} onClick={() => setInventoryPage((current) => current + 1)}>次へ</button><button type="button" className="subtle-button" aria-label="無視済み一覧の最後のページ" disabled={inventoryPage === inventoryPagination.pageCount} onClick={() => setInventoryPage(inventoryPagination.pageCount)}>最後</button></div>
          </nav>
          <p className="ignore-inspector-download" role="status" aria-live="polite">{inventoryExportStatus}</p>
        </>}
      </section>

      <section className="ignore-inspector-section" aria-labelledby="ignore-check-title" aria-busy={checkState === "loading"}>
        <div className="ignore-inspector-section-heading"><div><h4 id="ignore-check-title">候補パスのルール判定</h4><p>1行に1パス、最大{IGNORE_PATH_LIMIT}件です。追跡済みでもルールが適用されるかを判定します。</p></div></div>
        <label className="ignore-inspector-candidates"><span>候補パス（リポジトリ相対）</span><textarea ref={candidatesRef} value={candidates} onChange={(event) => { setCandidates(event.target.value); setCandidateEditStatus(""); }} rows={5} placeholder={"cache/generated.txt\nsrc/secret note.tmp\nkeep.log"} aria-label="ignoreルールを調べる候補パス" aria-invalid={candidates.length > 0 && candidateInfo.error !== null} aria-describedby="ignore-candidate-validation" /></label>
        <div className="ignore-inspector-candidate-summary"><span id="ignore-candidate-validation" role="status">候補 {candidateInfo.count} / {IGNORE_PATH_LIMIT}件{candidateInfo.duplicateCount > 0 && "・重複 " + candidateInfo.duplicateCount + "件"}{candidates.length > 0 && candidateInfo.error !== null && " · " + candidateInfo.error}</span><button type="button" className="subtle-button" disabled={candidateInfo.duplicateCount === 0 || checkState === "loading"} onClick={() => { setCandidates(deduplicateIgnoreCandidates(candidates)); setCandidateEditStatus("重複する" + candidateInfo.duplicateCount + "行を削除しました。先に入力したパスを保持しました。"); }}>重複行を削除</button></div>
        <div className="ignore-inspector-check-actions"><button type="button" className="primary-action" disabled={checkState === "loading" || candidateInfo.error !== null} onClick={runCheck}>{checkState === "loading" ? "判定中…" : checkResult !== null && !checkInputCurrent ? "変更した候補を判定" : "候補を判定"}</button><span className="ignore-inspector-input-note">空行は区切りとして扱います。パスの空白は保持します。</span></div>
        <p className="ignore-inspector-download" role="status" aria-live="polite">{candidateEditStatus}</p>
        {checkState === "error" && <p className="ignore-inspector-error" role="alert">候補パスを判定できませんでした。{checkError && <span>（{checkError}）</span>}{checkResult !== null && <span>以下は前回の判定結果です。</span>}</p>}
        {checkResult && <>
          <div className={"ignore-inspector-result-context" + (!checkInputCurrent ? " is-stale" : "")}>
            <p role="status">{checkState === "loading" ? "新しい判定を取得中です。以下は前回の判定結果です。" : checkInputCurrent ? "現在の候補入力と一致する判定結果です。" : "候補入力は判定後に変更されています。以下は前回送信したパスの結果です。"}</p>
            {!checkInputCurrent && <button type="button" className="subtle-button" disabled={checkedPaths === null || checkState === "loading"} onClick={() => { if (checkedPaths === null) return; setCandidates(checkedPaths.join("\n")); setCandidateEditStatus("前回判定した候補入力を復元しました。"); }}>判定時の入力を復元</button>}
          </div>
          <div className="ignore-inspector-outcomes" role="group" aria-label="候補の判定結果で絞り込み">{OUTCOME_LABELS.map((outcome) => <button type="button" key={outcome.value} aria-pressed={checkOutcome === outcome.value} disabled={outcome.value !== "all" && checkCounts[outcome.value] === 0} onClick={() => setCheckOutcome(outcome.value)}>{outcome.label} <strong>{checkCounts[outcome.value]}</strong></button>)}</div>
          <div className="ignore-inspector-summary"><span role="status">{visibleCheck.length} / {checkResult.results.length} 件</span><button type="button" className="subtle-button" disabled={visibleCheck.length === 0} onClick={() => downloadEntries(visibleCheck, "gitdash-ignore-diagnosis.csv", setCheckExportStatus)}>表示中の判定をCSV保存</button><button type="button" className="subtle-button" disabled={visibleCheck.length === 0} onClick={() => { void copyReport(visibleCheck, { repository: path, scope: "候補パスの判定", filters: ["判定: " + outcomeLabel(checkOutcome)], inventoryTruncated: null, inputCurrent: checkInputCurrent }, setCheckExportStatus); }}>判定レポートをコピー</button><span className="ignore-inspector-download" role="status" aria-live="polite">{checkExportStatus}</span></div>
          <EntryTable entries={visibleCheck} empty="条件に一致する候補パスはありません。" label="候補パスの判定結果" selection={null} />
        </>}
      </section>
    </div>
  </details>;
}

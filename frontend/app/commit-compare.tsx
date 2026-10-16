"use client";

import { useEffect, useId, useRef, useState } from "react";
import CopyButton from "./copy-button";
import CommitFiles from "./commit-files";
import PatchView from "./patch-view";
import InvestigationPresets, { type ComparisonPresetValues } from "./investigation-presets";
import type { Numstat } from "./types";
import {
  buildComparisonFilesCsv,
  buildComparisonQuery,
  comparisonModeLabel,
  comparisonPatchDownloadName,
  comparisonPatchDownloadStatus,
  comparisonReproductionCommand,
  swapComparisonValues,
} from "./commit-compare-tools.mjs";
import "./commit-compare.css";

type ComparisonMode = "direct" | "merge-base";
type LoadState = "idle" | "loading" | "ready" | "error";
type ComparisonRequest = { base: string; target: string; mode: ComparisonMode };
type ComparisonStats = {
  files: number;
  additions: number | null;
  deletions: number | null;
  binary: number;
  renamed: number;
};
type ComparisonResponse = {
  mode: ComparisonMode;
  base: string;
  target: string;
  comparison_base: string;
  merge_base: string | null;
  merge_bases: string[];
  comparison_label: string;
  files: Numstat[];
  stats: ComparisonStats;
  patch: string;
  patch_truncated: boolean;
  command: string;
};

type CommitCompareProps = { path: string };

function apiQuery(path: string, request: ComparisonRequest) {
  return buildComparisonQuery(path, request.base, request.target, request.mode);
}

async function fetchComparison(url: string, signal: AbortSignal): Promise<ComparisonResponse> {
  const response = await fetch(url, { cache: "no-store", signal });
  if (!response.ok) {
    let detail = "比較を取得できませんでした。";
    try {
      const body = (await response.json()) as { detail?: unknown; error?: unknown };
      if (typeof body.detail === "string" && body.detail.length > 0) detail = body.detail;
      else if (typeof body.error === "string" && body.error.length > 0) detail = body.error;
    } catch {
      // Keep the stable user-facing error when the proxy did not return JSON.
    }
    throw new Error(`${detail} (HTTP ${response.status})`);
  }
  return (await response.json()) as ComparisonResponse;
}

function displayStat(value: number | null) {
  return value === null ? "不明" : value.toLocaleString();
}

function sameRequest(left: ComparisonRequest | null, right: ComparisonRequest | null) {
  return left !== null
    && right !== null
    && left.base === right.base
    && left.target === right.target
    && left.mode === right.mode;
}

function downloadBlob(content: BlobPart, type: string, name: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ComparisonStats({ stats }: { stats: ComparisonStats }) {
  return (
    <div className="commit-compare-stats" aria-label="比較結果の集計">
      <div><span>ファイル</span><strong>{stats.files.toLocaleString()}</strong></div>
      <div><span>追加行（既知）</span><strong>{displayStat(stats.additions)}</strong></div>
      <div><span>削除行（既知）</span><strong>{displayStat(stats.deletions)}</strong></div>
      <div><span>バイナリ</span><strong>{stats.binary.toLocaleString()}</strong></div>
      <div><span>名前変更</span><strong>{stats.renamed.toLocaleString()}</strong></div>
    </div>
  );
}

export default function CommitCompare({ path }: CommitCompareProps) {
  const titleId = `commit-compare-title-${useId().replaceAll(":", "")}`;
  const [base, setBase] = useState("");
  const [target, setTarget] = useState("");
  const [mode, setMode] = useState<ComparisonMode>("direct");
  const [request, setRequest] = useState<ComparisonRequest | null>(null);
  const [loadedRequest, setLoadedRequest] = useState<ComparisonRequest | null>(null);
  const [data, setData] = useState<ComparisonResponse | null>(null);
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [downloadStatus, setDownloadStatus] = useState("");
  const [open, setOpen] = useState(false);
  const requestSequence = useRef(0);

  useEffect(() => {
    setBase("");
    setTarget("");
    setMode("direct");
    setRequest(null);
    setLoadedRequest(null);
    setData(null);
    setState("idle");
    setError(null);
    setValidationError(null);
    setRetry(0);
    setDownloadStatus("");
    setOpen(false);
  }, [path]);

  useEffect(() => {
    if (request === null) return;
    const controller = new AbortController();
    const sequence = ++requestSequence.current;
    setState("loading");
    setError(null);
    setDownloadStatus("");
    void fetchComparison(`/api/repo/compare?${apiQuery(path, request)}`, controller.signal)
      .then((value) => {
        if (controller.signal.aborted || requestSequence.current !== sequence) return;
        setData(value);
        setLoadedRequest(request);
        setState("ready");
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || requestSequence.current !== sequence) return;
        setError(reason instanceof Error ? reason.message : "比較を取得できませんでした。");
        setState("error");
      });
    return () => controller.abort();
  }, [path, request, retry]);

  const runComparison = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next: ComparisonRequest = { base: base.trim(), target: target.trim(), mode };
    if (next.base.length === 0 || next.target.length === 0) {
      setValidationError("base と target の両方を入力してください。比較対象は自動補完しません。");
      setState("idle");
      return;
    }
    setValidationError(null);
    setRequest(next);
    setRetry(0);
  };

  const swap = () => {
    const next = swapComparisonValues({ base, target });
    setBase(next.base);
    setTarget(next.target);
    setValidationError(null);
  };

  const retryComparison = () => {
    if (request === null) return;
    setRetry((value) => value + 1);
  };

  const applyPreset = (values: ComparisonPresetValues) => {
    setBase(values.base);
    setTarget(values.target);
    setMode(values.mode);
    setValidationError(null);
    setOpen(true);
  };

  const exportCsv = () => {
    if (data === null) return;
    try {
      downloadBlob(
        buildComparisonFilesCsv(data.files),
        "text/csv;charset=utf-8",
        `${data.base.slice(0, 12)}-${data.target.slice(0, 12)}-files.csv`,
      );
      setDownloadStatus("比較ファイル一覧CSVの保存を開始しました。");
    } catch {
      setDownloadStatus("比較ファイル一覧CSVを保存できませんでした。");
    }
  };

  const downloadPatch = () => {
    if (data === null) return;
    try {
      downloadBlob(data.patch, "text/x-patch;charset=utf-8", comparisonPatchDownloadName(data));
      setDownloadStatus(comparisonPatchDownloadStatus(data.patch_truncated));
    } catch {
      setDownloadStatus("パッチを保存できませんでした。");
    }
  };

  const resultIsCurrent = sameRequest({ base: base.trim(), target: target.trim(), mode }, loadedRequest);
  return (
    <details className="commit-compare" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary id={titleId}>2地点を比較する</summary>
      <div className="commit-compare-body">
        <p className="commit-compare-intro">base と target を明示して、読み取り専用のコミット差分を確認します。ブランチ名の推測や自動fetchは行いません。</p>
        <InvestigationPresets
          kind="compare"
          repoPath={path}
          values={{ base, target, mode }}
          onApply={(values) => applyPreset(values as ComparisonPresetValues)}
        />
        <form className="commit-compare-form" onSubmit={runComparison}>
          <label>
            <span>base（比較元）</span>
            <input
              type="text"
              value={base}
              onChange={(event) => setBase(event.target.value)}
              placeholder="コミットハッシュまたは refs/heads/main"
              aria-label="比較元 base のコミットハッシュまたはGit ref"
              autoComplete="off"
              required
            />
          </label>
          <button className="commit-compare-swap" type="button" onClick={swap} aria-label="base と target を入れ替える">⇄ 入れ替え</button>
          <label>
            <span>target（比較先）</span>
            <input
              type="text"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              placeholder="コミットハッシュまたは refs/heads/feature"
              aria-label="比較先 target のコミットハッシュまたはGit ref"
              autoComplete="off"
              required
            />
          </label>
          <label className="commit-compare-mode">
            <span>比較方法</span>
            <select aria-label="コミット比較の方法" value={mode} onChange={(event) => setMode(event.target.value as ComparisonMode)}>
              <option value="direct">直接比較（base → target）</option>
              <option value="merge-base">共通祖先（merge-base）→ target</option>
            </select>
          </label>
          <button className="commit-compare-run" type="submit" disabled={state === "loading"}>
            {state === "loading" ? "比較を取得中…" : "この2地点を比較"}
          </button>
        </form>
        {validationError && <p className="commit-compare-validation" role="alert">{validationError}</p>}

        {state === "loading" && <p className="commit-compare-loading" role="status" aria-live="polite">比較を取得中…</p>}
        {state === "error" && (
          <div className="commit-compare-error" role="alert">
            <span>{data ? "比較を更新できませんでした。前回取得した内容を表示しています。" : "比較を取得できませんでした。"}</span>
            {error && <small>{error}</small>}
            <button type="button" onClick={retryComparison}>同じ入力で再取得</button>
            {request && <small>base: <code>{request.base}</code> · target: <code>{request.target}</code> · {comparisonModeLabel(request.mode)}</small>}
          </div>
        )}

        {data && (
          <section className={`commit-compare-result${resultIsCurrent ? "" : " is-stale"}`} aria-labelledby={`${titleId}-result`}>
            <div className="commit-compare-result-head">
              <div>
                <h3 id={`${titleId}-result`}>比較結果</h3>
                <p className="commit-compare-label"><span>{comparisonModeLabel(data.mode)}</span> <code>{data.comparison_label}</code></p>
                {!resultIsCurrent && <p className="commit-compare-stale" role="status">入力値が変更されています。表示中の結果は前回の比較です。「この2地点を比較」で更新してください。</p>}
              </div>
              <div className="commit-compare-actions">
                <button type="button" onClick={exportCsv}>ファイル一覧をCSV保存</button>
                <button type="button" onClick={downloadPatch}>{data.patch_truncated ? "部分パッチを保存" : "生パッチを保存"}</button>
              </div>
            </div>
            <ComparisonStats stats={data.stats} />
            <div className="commit-compare-command">
              <div><span>再現コマンド（読み取り専用・ハッシュ固定）</span><code>{comparisonReproductionCommand(path, data.command)}</code></div>
              <CopyButton value={comparisonReproductionCommand(path, data.command)} label="比較の再現コマンドをコピー" />
            </div>
            {downloadStatus && <p className="commit-compare-download-status" role="status" aria-live="polite">{downloadStatus}</p>}
            <CommitFiles key={`${data.base}:${data.target}:${data.mode}`} files={data.files} downloadName={`${data.base.slice(0, 12)}-${data.target.slice(0, 12)}-files.tsv`} />
            <PatchView key={`${data.comparison_base}:${data.target}`} patch={data.patch} />
            {data.patch_truncated && <p className="commit-compare-truncated" role="status">パッチ本文は上限で切り詰められています。保存したファイルも部分的な内容です。</p>}
          </section>
        )}
      </div>
    </details>
  );
}

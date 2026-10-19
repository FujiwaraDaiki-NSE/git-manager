"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import CommitFiles from "./commit-files";
import CopyButton from "./copy-button";
import PatchView from "./patch-view";
import type { Numstat } from "./types";
import {
  buildWorktreeDiffQuery,
  sameWorktreeDiffRequest,
  worktreeExcludedLabel,
  worktreePatchDownloadName,
  worktreePatchDownloadStatus,
  worktreeStageLabel,
} from "./worktree-diff-tools.mjs";
import "./worktree-diff.css";

export type WorktreeDiffStage = "staged" | "unstaged";

export type WorktreeDiffProps = {
  path: string;
  file: string | null;
  stage: WorktreeDiffStage;
};

type WorktreeDiffRequest = {
  path: string;
  file: string | null;
  stage: WorktreeDiffStage;
  ignoreWhitespace: boolean;
};

type WorktreeDiffStats = {
  files: number;
  additions: number | null;
  deletions: number | null;
  binary: number;
  renamed: number;
};

type WorktreeDiffSnapshot = {
  stage: WorktreeDiffStage;
  stage_label: string;
  file: string | null;
  scope: "all" | "file";
  ignore_whitespace: boolean;
};

type WorktreeDiffResponse = {
  stage: WorktreeDiffStage;
  stage_label: string;
  file: string | null;
  ignore_whitespace: boolean;
  input: {
    stage: WorktreeDiffStage;
    file: string | null;
    ignore_whitespace: boolean;
  };
  snapshot: WorktreeDiffSnapshot;
  scope: "all" | "file";
  files: Numstat[];
  stats: WorktreeDiffStats;
  patch: string;
  patch_truncated: boolean;
  patch_complete: boolean;
  patch_bytes: number;
  patch_limit_bytes: number;
  metadata_complete: boolean;
  excluded: {
    untracked: string[];
    conflict: string[];
    not_in_diff: string[];
  };
  command: string;
};

type LoadState = "loading" | "ready" | "error";

function responseMessage(status: number, detail: string | null) {
  if (status === 404) return "このリポジトリは見つかりません。再走査して確認してください。";
  if (status === 409) return detail ?? "差分取得中にGitの状態が変わりました。更新して再試行してください。";
  if (status === 422) return detail ?? "差分の指定が不正です。";
  return detail ?? "差分を取得できませんでした。Gitの状態を確認して再試行してください。";
}

async function readResponseError(response: Response) {
  let detail: string | null = null;
  try {
    const body = (await response.json()) as { detail?: unknown; error?: unknown };
    if (typeof body.detail === "string" && body.detail.length > 0) detail = body.detail;
    else if (typeof body.error === "string" && body.error.length > 0) detail = body.error;
  } catch {
    // Keep the status-specific message when the proxy has no JSON body.
  }
  return responseMessage(response.status, detail);
}

function displayStat(value: number | null) {
  return value === null ? "不明" : value.toLocaleString();
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

function WorktreeDiffStats({ stats }: { stats: WorktreeDiffStats }) {
  return (
    <div className="worktree-diff-stats" aria-label="作業ツリー差分の集計">
      <div><span>ファイル</span><strong>{stats.files.toLocaleString()}</strong></div>
      <div><span>追加行（既知）</span><strong>{displayStat(stats.additions)}</strong></div>
      <div><span>削除行（既知）</span><strong>{displayStat(stats.deletions)}</strong></div>
      <div><span>バイナリ</span><strong>{stats.binary.toLocaleString()}</strong></div>
      <div><span>名前変更・コピー</span><strong>{stats.renamed.toLocaleString()}</strong></div>
    </div>
  );
}

export default function WorktreeDiff({ path, file, stage }: WorktreeDiffProps) {
  const titleId = `worktree-diff-title-${useId().replaceAll(":", "")}`;
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [data, setData] = useState<WorktreeDiffResponse | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [downloadStatus, setDownloadStatus] = useState("");
  const [retry, setRetry] = useState(0);
  const loadedRequest = useRef<WorktreeDiffRequest | null>(null);
  const requestSequence = useRef(0);

  const request = useMemo<WorktreeDiffRequest>(
    () => ({ path, file, stage, ignoreWhitespace }),
    [file, ignoreWhitespace, path, stage],
  );

  useEffect(() => {
    const controller = new AbortController();
    const sequence = ++requestSequence.current;
    setData(null);
    loadedRequest.current = null;
    setError(null);
    setDownloadStatus("");
    setState("loading");

    const params = buildWorktreeDiffQuery(
      request.path,
      request.stage,
      request.file,
      request.ignoreWhitespace,
    );
    void fetch(`/api/repo/worktree-diff?${params}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readResponseError(response));
        return await response.json() as WorktreeDiffResponse;
      })
      .then((value) => {
        if (controller.signal.aborted || requestSequence.current !== sequence) return;
        setData(value);
        loadedRequest.current = request;
        setState("ready");
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || requestSequence.current !== sequence) return;
        setError(reason instanceof Error ? reason.message : "差分を取得できませんでした。");
        setState("error");
      });

    return () => controller.abort();
  }, [request, retry]);

  const resultIsCurrent = sameWorktreeDiffRequest(request, loadedRequest.current);
  const exclusionLabel = data ? worktreeExcludedLabel(data.excluded) : null;

  const downloadPatch = () => {
    if (data === null) return;
    try {
      downloadBlob(
        data.patch,
        "text/x-patch;charset=utf-8",
        worktreePatchDownloadName({
          stage: data.stage,
          file: data.file,
          patch_truncated: data.patch_truncated,
        }),
      );
      setDownloadStatus(worktreePatchDownloadStatus(data.patch_truncated));
    } catch {
      setDownloadStatus("パッチを保存できませんでした。");
    }
  };

  return (
    <section className={`worktree-diff${resultIsCurrent ? "" : " is-stale"}`} aria-labelledby={titleId}>
      <div className="worktree-diff-heading">
        <div>
          <h3 id={titleId}>{file === null ? "作業ツリーの差分" : "選択ファイルの差分"}</h3>
          <p>
            {file === null ? "変更中の追跡ファイル全体" : <><code>{file}</code> の変更</>}
            <span className="worktree-diff-readonly">読み取り専用</span>
          </p>
        </div>
        <div className="worktree-diff-actions">
          <button type="button" onClick={() => setRetry((value) => value + 1)} disabled={state === "loading"}>
            {state === "loading" ? "取得中…" : "差分を更新"}
          </button>
          {data && <button type="button" onClick={downloadPatch}>{data.patch_truncated ? "部分パッチを保存" : "生パッチを保存"}</button>}
        </div>
      </div>

      <label className="worktree-diff-ignore">
        <input
          type="checkbox"
          aria-label="空白変更を無視"
          aria-describedby={`${titleId}-ignore-note`}
          checked={ignoreWhitespace}
          onChange={(event) => setIgnoreWhitespace(event.target.checked)}
        />
        <span>空白だけの変更を無視</span>
        <small id={`${titleId}-ignore-note`}>変更すると差分を再取得します。</small>
      </label>

      {state === "loading" && <p className="worktree-diff-loading" role="status" aria-live="polite">{worktreeStageLabel(stage)}の差分を取得中…</p>}
      {state === "error" && (
        <div className="worktree-diff-error" role="alert">
          <span>{error ?? "差分を取得できませんでした。"}</span>
          <button type="button" onClick={() => setRetry((value) => value + 1)}>同じ条件で再取得</button>
        </div>
      )}

      {data && (
        <>
          <div className="worktree-diff-snapshot" role="status">
            <span>取得したスナップショット</span>
            <strong>{data.snapshot.stage_label}</strong>
            <span>{data.snapshot.scope === "all" ? "全体" : <code>{data.snapshot.file}</code>}</span>
            {data.snapshot.ignore_whitespace && <span>空白変更を無視（意味のある差分のみ）</span>}
            {!resultIsCurrent && <span className="worktree-diff-stale">入力変更後の前回結果です。更新してください。</span>}
          </div>
          <WorktreeDiffStats stats={data.stats} />
          <div className="worktree-diff-command">
            <div><span>再現コマンド（読み取り専用）</span><code>{data.command}</code></div>
            <CopyButton value={data.command} label="作業ツリー差分の再現コマンドをコピー" />
          </div>
          {downloadStatus && <p className="worktree-diff-download-status" role="status" aria-live="polite">{downloadStatus}</p>}
          {exclusionLabel && (
            <p className="worktree-diff-exclusion" role="status">
              {exclusionLabel}{data.excluded.untracked.length > 0 && " 未追跡ファイルの内容は表示していません。"}
            </p>
          )}
          {!data.metadata_complete && <p className="worktree-diff-exclusion" role="status">ファイル一覧が完全ではありません。再取得して確認してください。</p>}
          <CommitFiles
            key={`${data.stage}:${data.file ?? "all"}:${data.ignore_whitespace}:files`}
            files={data.files}
            downloadName={worktreePatchDownloadName({ stage: data.stage, file: data.file, patch_truncated: false }).replace(/\.patch$/, "-files.tsv")}
          />
          <PatchView key={`${data.stage}:${data.file ?? "all"}:${data.ignore_whitespace}:patch`} patch={data.patch} />
          {data.patch_truncated && (
            <p className="worktree-diff-truncated" role="status">
              パッチ本文は{data.patch_limit_bytes.toLocaleString()} bytesで切り詰められています。保存したファイル名にも「partial」と表示しています。ファイル一覧と集計は完全です。
            </p>
          )}
        </>
      )}
    </section>
  );
}

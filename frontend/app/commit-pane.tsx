"use client";

import { useEffect, useState } from "react";
import type { CommitDetail } from "./types";
import { truncationLabel } from "./status";

export type LoadState = "idle" | "loading" | "ready" | "error";

const COMMIT_FETCH_DEBOUNCE_MS = 150;

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as T;
}

function apiQuery(path: string, params: Record<string, string>) {
  const search = new URLSearchParams({ path, ...params });
  return search.toString();
}

export type CommitLoad = {
  detail: CommitDetail | null;
  state: LoadState;
  error: string | null;
  retry: () => void;
};

/** Shared commit-detail request lifecycle for repo and project views. */
export function useCommitDetail(
  repoPath: string | null,
  selectedHash: string | null,
  enabled = true,
): CommitLoad {
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (!enabled || !repoPath || !selectedHash) {
      setDetail(null);
      setState("idle");
      setError(null);
      return;
    }
    const controller = new AbortController();
    setDetail(null);
    setState("loading");
    setError(null);
    const timer = window.setTimeout(() => {
      void getJson<CommitDetail>(
        `/api/repo/commit?${apiQuery(repoPath, { hash: selectedHash })}`,
        controller.signal,
      )
        .then((value) => {
          setDetail(value);
          setState("ready");
        })
        .catch((reason: unknown) => {
          if (reason instanceof DOMException && reason.name === "AbortError") return;
          setError(reason instanceof Error ? reason.message : "unknown error");
          setState("error");
        });
    }, COMMIT_FETCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, repoPath, retryCount, selectedHash]);

  return {
    detail,
    state,
    error,
    retry: () => setRetryCount((value) => value + 1),
  };
}

export type CommitPaneProps = {
  detail: CommitDetail | null;
  state: LoadState;
  error: string | null;
  onRetry: () => void;
  onCopy: (command: string) => void;
  title?: string;
};

export function CommitPane({
  detail,
  state,
  error,
  onRetry,
  onCopy,
  title = "コミット詳細",
}: CommitPaneProps) {
  if (state === "idle") return null;
  return (
    <section
      aria-busy={state === "loading"}
      aria-labelledby="commit-pane-title"
      className="commit-pane"
    >
      <div className="section-head">
        <div>
          <h3 id="commit-pane-title">{title}</h3>
          {detail && <code className="cmdhint">{detail.command}</code>}
        </div>
        {detail && (
          <button className="copy" type="button" onClick={() => onCopy(detail.command)}>
            コマンドをコピー
          </button>
        )}
      </div>
      {state === "loading" && (
        <div className="loading" role="status">
          コミット詳細を取得中…
        </div>
      )}
      {state === "error" && (
        <div className="inline-error" role="alert">
          コミット詳細を取得できませんでした。
          <button className="copy" type="button" onClick={onRetry}>
            再取得
          </button>
          {error && <span className="sr-only">{error}</span>}
        </div>
      )}
      {state === "ready" && detail && (
        <>
          <div className="commit-meta">
            <strong>{detail.subject || "(no subject)"}</strong>
            <span>{detail.author}</span>
            <span>{detail.date}</span>
          </div>
          <div className="numstat" aria-label="変更ファイルの集計">
            <div className="numstat-head">
              <span>追加</span>
              <span>削除</span>
              <span>パス</span>
            </div>
            {detail.files.map((file) => (
              <div className="numstat-row" key={file.path}>
                <span className="additions">{file.additions}</span>
                <span className="deletions">{file.deletions}</span>
                <span className="file-path">
                  {file.path}
                  {file.binary && <span className="binary"> (binary)</span>}
                </span>
              </div>
            ))}
            {detail.files.length === 0 && <div className="muted-line">変更ファイルはありません</div>}
          </div>
          <pre className="patch" aria-label="コミットの diff">
            {detail.patch}
          </pre>
          {detail.patch_truncated && (
            <div className="truncated" role="status">
              {truncationLabel(200)}
            </div>
          )}
        </>
      )}
    </section>
  );
}

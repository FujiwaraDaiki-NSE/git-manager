"use client";

import { useEffect, useMemo, useState } from "react";
import { GraphView } from "./graph-view";
import {
  BranchesResponse,
  CommitDetail,
  GraphResponse,
  Repo,
} from "./types";

type RepoDetailProps = {
  repo: Repo;
  copied: string | null;
  onCopy: (command: string) => void;
};

type LoadState = "idle" | "loading" | "ready" | "error";

const GRAPH_LIMIT = 200;
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

function codeColor(xy: string) {
  if (xy === "??") return "var(--c-untracked)";
  if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(xy)) return "var(--c-conflict)";
  if (xy[1] !== ".") return "var(--c-worktree)";
  return "var(--c-index)";
}

/** porcelain v2 の "." を、git status -sb と同じ空白に戻す */
const display = (xy: string) => xy.replace(/\./g, " ");

function BranchLine({ line }: { line: string }) {
  const m = line.match(/^(## [^\[]*)(\[.*\])?$/);
  if (!m) return <span>{line}</span>;
  return (
    <>
      <span className="head">{m[1]}</span>
      {m[2] && <span className="ab">{m[2]}</span>}
    </>
  );
}

function StatusBlock({ repo }: { repo: Repo }) {
  return (
    <div className="statusblock">
      <div style={{ color: "var(--muted)" }}>
        {repo.branch_line ? <BranchLine line={repo.branch_line} /> : "—"}
      </div>
      {(repo.entries ?? []).slice(0, 40).map((entry) => (
        <div key={entry.xy + entry.path}>
          <span className="xy" style={{ color: codeColor(entry.xy) }}>{display(entry.xy)}</span>
          {entry.path}
        </div>
      ))}
      {(repo.entries?.length ?? 0) > 40 && (
        <div style={{ color: "var(--muted)" }}>… 他 {(repo.entries?.length ?? 0) - 40} 件</div>
      )}
      {(repo.entries?.length ?? 0) === 0 && (
        <div style={{ color: "var(--muted)" }}>nothing to commit, working tree clean</div>
      )}
    </div>
  );
}

function CommitPane({ detail, state, error, onRetry, onCopy }: {
  detail: CommitDetail | null;
  state: LoadState;
  error: string | null;
  onRetry: () => void;
  onCopy: (command: string) => void;
}) {
  if (state === "idle") return null;
  return (
    <section
      aria-busy={state === "loading"}
      aria-labelledby="commit-pane-title"
      className="commit-pane"
    >
      <div className="section-head">
        <div>
          <h3 id="commit-pane-title">コミット詳細</h3>
          {detail && <code className="cmdhint">{detail.command}</code>}
        </div>
        {detail && (
          <button className="copy" type="button" onClick={() => onCopy(detail.command)}>
            コマンドをコピー
          </button>
        )}
      </div>
      {state === "loading" && <div className="loading" role="status">コミット詳細を取得中…</div>}
      {state === "error" && (
        <div className="inline-error" role="alert">
          コミット詳細を取得できませんでした。
          <button className="copy" type="button" onClick={onRetry}>再取得</button>
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
            <div className="numstat-head"><span>追加</span><span>削除</span><span>パス</span></div>
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
          <pre className="patch" aria-label="コミットの diff">{detail.patch}</pre>
          {detail.patch_truncated && (
            <div className="truncated" role="status">diff は大きいため途中まで表示しています。</div>
          )}
        </>
      )}
    </section>
  );
}

function BranchRow({ branch }: { branch: BranchesResponse["local"][number] }) {
  const collapsedMerged = branch.merged && !branch.current;
  return (
    <div className={`branch-row${collapsedMerged ? " merged" : ""}`}>
      <span className={branch.current ? "branch-name current" : "branch-name"}>
        {branch.current && <span className="branch-marker" aria-label="現在のブランチ">*</span>}
        {branch.name}
      </span>
      <code>{branch.hash}</code>
      {branch.upstream && <span className="branch-upstream">{branch.upstream}</span>}
      {branch.track && <span className="branch-track">{branch.track}</span>}
      <time className="branch-date" dateTime={branch.date}>{branch.date}</time>
      {collapsedMerged && <span className="branch-merged">merged</span>}
    </div>
  );
}

function BranchesPane({ data, state, error, showMerged, onShowMerged, onRetry }: {
  data: BranchesResponse | null;
  state: LoadState;
  error: string | null;
  showMerged: boolean;
  onShowMerged: (show: boolean) => void;
  onRetry: () => void;
}) {
  if (state === "idle") return null;
  const local = data?.local ?? [];
  const remote = data?.remotes ?? [];
  const visibleLocal = showMerged ? local : local.filter((branch) => branch.current || !branch.merged);
  const mergedCount = local.filter((branch) => !branch.current && branch.merged).length;

  return (
    <section
      aria-busy={state === "loading"}
      aria-labelledby="branches-pane-title"
      className="branches-pane"
    >
      <div className="section-head">
        <div>
          <h3 id="branches-pane-title">ブランチ</h3>
          {data && <code className="cmdhint">{data.command}</code>}
        </div>
        {data && (
          <label className="toggle-label">
            <input
              type="checkbox"
              checked={showMerged}
              onChange={(event) => onShowMerged(event.target.checked)}
            />
            マージ済みを表示
          </label>
        )}
      </div>
      {state === "loading" && <div className="loading" role="status">ブランチを取得中…</div>}
      {state === "error" && (
        <div className="inline-error" role="alert">
          ブランチを取得できませんでした。
          <button className="copy" type="button" onClick={onRetry}>再取得</button>
          {error && <span className="sr-only">{error}</span>}
        </div>
      )}
      {(state === "loading" || state === "ready") && data && (
        <div className="branch-groups">
          <div className="branch-group">
            <h4>ローカル</h4>
            {visibleLocal.map((branch) => <BranchRow key={branch.name} branch={branch} />)}
            {!showMerged && mergedCount > 0 && (
              <div className="muted-line">マージ済み {mergedCount} 件を折りたたんでいます</div>
            )}
            {visibleLocal.length === 0 && mergedCount === 0 && (
              <div className="muted-line">
                ローカルブランチはありません
              </div>
            )}
          </div>
          <div className="branch-group">
            <h4>リモート</h4>
            {remote.map((branch) => <BranchRow key={branch.name} branch={branch} />)}
            {remote.length === 0 && <div className="muted-line">リモートブランチはありません</div>}
          </div>
        </div>
      )}
    </section>
  );
}

export default function RepoDetail({ repo, copied, onCopy }: RepoDetailProps) {
  const [allRefs, setAllRefs] = useState(false);
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [graphState, setGraphState] = useState<LoadState>("idle");
  const [graphError, setGraphError] = useState<string | null>(null);
  const [graphRetry, setGraphRetry] = useState(0);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [commit, setCommit] = useState<CommitDetail | null>(null);
  const [commitState, setCommitState] = useState<LoadState>("idle");
  const [commitError, setCommitError] = useState<string | null>(null);
  const [commitRetry, setCommitRetry] = useState(0);
  const [branches, setBranches] = useState<BranchesResponse | null>(null);
  const [branchesState, setBranchesState] = useState<LoadState>("idle");
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const [branchesRetry, setBranchesRetry] = useState(0);
  const [showMerged, setShowMerged] = useState(false);

  useEffect(() => {
    setSelectedHash(null);
    setCommit(null);
    setCommitState("idle");
    setCommitError(null);
    setShowMerged(false);
  }, [repo.path]);

  useEffect(() => {
    const controller = new AbortController();
    setGraphState("loading");
    setGraphError(null);
    void getJson<GraphResponse>(
      `/api/repo/graph?${apiQuery(repo.path, { all: String(allRefs), limit: String(GRAPH_LIMIT) })}`,
      controller.signal,
    ).then((value) => {
      setGraph(value);
      setGraphState("ready");
    }).catch((reason: unknown) => {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setGraphError(reason instanceof Error ? reason.message : "unknown error");
      setGraphState("error");
    });
    return () => controller.abort();
  }, [allRefs, graphRetry, repo.branch, repo.last_commit?.hash, repo.path]);

  useEffect(() => {
    const controller = new AbortController();
    setBranchesState("loading");
    setBranchesError(null);
    void getJson<BranchesResponse>(
      `/api/repo/branches?${apiQuery(repo.path, {})}`,
      controller.signal,
    ).then((value) => {
      setBranches(value);
      setBranchesState("ready");
    }).catch((reason: unknown) => {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setBranchesError(reason instanceof Error ? reason.message : "unknown error");
      setBranchesState("error");
    });
    return () => controller.abort();
  }, [branchesRetry, repo.branch, repo.last_commit?.hash, repo.path]);

  useEffect(() => {
    if (!selectedHash) {
      setCommit(null);
      setCommitState("idle");
      return;
    }
    const controller = new AbortController();
    setCommit(null);
    setCommitState("loading");
    setCommitError(null);
    const timer = window.setTimeout(() => {
      void getJson<CommitDetail>(
        `/api/repo/commit?${apiQuery(repo.path, { hash: selectedHash })}`,
        controller.signal,
      ).then((value) => {
        setCommit(value);
        setCommitState("ready");
      }).catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setCommitError(reason instanceof Error ? reason.message : "unknown error");
        setCommitState("error");
      });
    }, COMMIT_FETCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [repo.path, selectedHash, commitRetry]);

  const virtualNode = useMemo(() => {
    if (!graph || !repo.entries?.length || graph.head_lane === null || !repo.branch_line) return undefined;
    return {
      lane: graph.head_lane,
      label: repo.branch_line,
      summary: (repo.counts ?? []).map((count) => `${display(count.xy)} ${count.count}`).join("  "),
    };
  }, [graph, repo.branch_line, repo.counts, repo.entries]);

  return (
    <div className="detail">
      <StatusBlock repo={repo} />

      <div className="legend">
        <span>左列 = index</span>
        <span>右列 = worktree</span>
        <span>?? = 未追跡</span>
        {repo.remote && <span>{repo.remote}</span>}
      </div>

      {repo.next_command && (
        <div className="next">
          <div className="reason">{repo.next_command.reason}。次はこれです</div>
          <div className="cmdrow">
            <code>{repo.next_command.command}</code>
            <button className="copy" type="button" onClick={() => onCopy(repo.next_command!.command)}>
              {copied === repo.next_command.command ? "コピーしました" : "コピー"}
            </button>
          </div>
        </div>
      )}

      <section
        aria-busy={graphState === "loading"}
        aria-labelledby="graph-pane-title"
        className="graph-pane"
      >
        <div className="section-head">
          <div>
            <h3 id="graph-pane-title">コミットグラフ</h3>
            {graph && <code className="cmdhint">{graph.command}</code>}
          </div>
          <label className="toggle-label">
            <input
              type="checkbox"
              checked={allRefs}
              onChange={(event) => setAllRefs(event.target.checked)}
            />
            --all
          </label>
        </div>
        {graphState === "loading" && <div className="loading" role="status">コミットグラフを取得中…</div>}
        {graphState === "error" && (
          <div className="inline-error" role="alert">
            コミットグラフを取得できませんでした。
            <button className="copy" type="button" onClick={() => setGraphRetry((value) => value + 1)}>再取得</button>
            {graphError && <span className="sr-only">{graphError}</span>}
          </div>
        )}
      {(graphState === "loading" || graphState === "ready") && graph && (
          <>
            {graph.rows.length > 0 || virtualNode ? (
              <GraphView
                rows={graph.rows}
                maxLane={graph.max_lane}
                selectedHash={selectedHash}
                onSelect={setSelectedHash}
                virtualNode={virtualNode}
              />
            ) : (
              <div className="muted-line">コミットがありません</div>
            )}
            {graph.truncated && (
              <div className="truncated" role="status">{GRAPH_LIMIT} 件まで表示しています。</div>
            )}
          </>
        )}
      </section>

      <CommitPane
        detail={commit}
        state={commitState}
        error={commitError}
        onRetry={() => setCommitRetry((value) => value + 1)}
        onCopy={onCopy}
      />

      <BranchesPane
        data={branches}
        state={branchesState}
        error={branchesError}
        showMerged={showMerged}
        onShowMerged={setShowMerged}
        onRetry={() => setBranchesRetry((value) => value + 1)}
      />
    </div>
  );
}

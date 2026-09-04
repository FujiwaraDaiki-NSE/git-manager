"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BranchRelationSummary,
  GraphView,
} from "./graph-view";
import { buildBranchRelationSummary } from "./branch-relation.mjs";
import { BranchesResponse, GraphResponse, Repo } from "./types";
import { codeColor, stateBadges } from "./status";
import { CommitPane, useCommitDetail, type LoadState } from "./commit-pane";

export type DetailTab = "status" | "graph" | "branches";

type RepoDetailProps = {
  repo: Repo;
  copied: string | null;
  onCopy: (command: string) => void;
  onProjectSelect: () => void;
  activeTab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
};

const GRAPH_LIMIT = 200;

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as T;
}

function apiQuery(path: string, params: Record<string, string>) {
  const search = new URLSearchParams({ path, ...params });
  return search.toString();
}

/** porcelain v2 の "." を、git status -sb と同じ空白に戻す */
const display = (xy: string) => xy.replace(/\./g, " ");

function xyTitle(xy: string) {
  const index = xy[0] === "." ? " " : xy[0];
  const worktree = xy[1] === "." ? " " : xy[1];
  return `index: ${index} / worktree: ${worktree}`;
}

function projectName(repo: Repo) {
  const parts = repo.common_dir.split("/").filter(Boolean);
  return parts.at(-1) ?? repo.common_dir;
}

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
  const badges = stateBadges(repo);
  return (
    <div className="statusblock">
      <div className="status-branch">
        {repo.branch_line ? <BranchLine line={repo.branch_line} /> : "—"}
      </div>
      <div className="status-badges" aria-label="状態">
        {badges.map((badge) => (
          <span
            className={`state-badge token-${badge.token}`}
            key={`${badge.token}-${badge.text}`}
          >
            {badge.text}
          </span>
        ))}
      </div>
      {(repo.entries ?? []).slice(0, 40).map((entry) => (
        <div key={entry.xy + entry.path}>
          <span
            className="xy"
            style={{ color: codeColor(entry.xy) }}
            title={xyTitle(entry.xy)}
          >
            {display(entry.xy)}
          </span>
          {entry.path}
        </div>
      ))}
      {(repo.entries?.length ?? 0) > 40 && (
        <div className="muted-line">
          … 他 {(repo.entries?.length ?? 0) - 40} 件
        </div>
      )}
      {badges.some((badge) => badge.token === "clean") && (
        <div className="muted-line">nothing to commit, working tree clean</div>
      )}
    </div>
  );
}

function StatusPane({ repo }: { repo: Repo }) {
  return (
    <section className="status-pane" aria-labelledby="status-pane-title">
      <div className="section-head">
        <h3 id="status-pane-title">変更ファイル</h3>
        <code className="cmdhint">git status --short</code>
      </div>
      <div className="status-files">
        {(repo.entries ?? []).map((entry) => (
          <div key={entry.xy + entry.path}>
            <span
              className="xy"
              style={{ color: codeColor(entry.xy) }}
              title={xyTitle(entry.xy)}
            >
              {display(entry.xy)}
            </span>
            {entry.path}
          </div>
        ))}
        {(repo.entries?.length ?? 0) === 0 && (
          <div className="muted-line">変更ファイルはありません</div>
        )}
      </div>
    </section>
  );
}

function BranchRow({
  branch,
  onCopy,
}: {
  branch: BranchesResponse["local"][number];
  onCopy: (command: string) => void;
}) {
  const collapsedMerged = branch.merged && !branch.current;
  const abandonedCandidate = collapsedMerged && !branch.worktree;
  return (
    <div
      className={`branch-row${collapsedMerged ? " merged" : ""}${abandonedCandidate ? " abandoned" : ""}`}
    >
      <span className={branch.current ? "branch-name current" : "branch-name"}>
        {branch.current && (
          <span className="branch-marker" aria-label="現在のブランチ">
            *
          </span>
        )}
        {branch.name}
      </span>
      <code>{branch.hash}</code>
      {branch.upstream && (
        <span className="branch-upstream">{branch.upstream}</span>
      )}
      {branch.track && <span className="branch-track">{branch.track}</span>}
      <time className="branch-date" dateTime={branch.date}>
        {branch.date}
      </time>
      <span className="branch-state">
        {branch.worktree && (
          <span className="branch-worktree" title={branch.worktree}>
            作業中 @ {branch.worktree}
          </span>
        )}
        {abandonedCandidate && (
          <span className="branch-action">
            <span className="branch-abandoned">merged · 削除候補</span>
            <button
              className="branch-delete"
              type="button"
              onClick={() => onCopy(`git branch -d ${shellQuote(branch.name)}`)}
            >
              削除コマンドをコピー
            </button>
          </span>
        )}
        {collapsedMerged && !abandonedCandidate && (
          <span className="branch-merged">merged</span>
        )}
      </span>
    </div>
  );
}

function BranchesPane({
  data,
  state,
  error,
  showMerged,
  onShowMerged,
  onRetry,
  onCopy,
}: {
  data: BranchesResponse | null;
  state: LoadState;
  error: string | null;
  showMerged: boolean;
  onShowMerged: (show: boolean) => void;
  onRetry: () => void;
  onCopy: (command: string) => void;
}) {
  if (state === "idle") return null;
  const local = data?.local ?? [];
  const remote = data?.remotes ?? [];
  // A merged branch checked out in another worktree remains active and must
  // stay visible in the default view.
  const visibleLocal = showMerged
    ? local
    : local.filter(
        (branch) => branch.current || !branch.merged || branch.worktree,
      );
  const mergedCount = local.filter(
    (branch) => !branch.current && branch.merged && !branch.worktree,
  ).length;

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
      </div>
      {state === "loading" && (
        <div className="loading" role="status">
          ブランチを取得中…
        </div>
      )}
      {state === "error" && (
        <div className="inline-error" role="alert">
          ブランチを取得できませんでした。
          <button className="copy" type="button" onClick={onRetry}>
            再取得
          </button>
          {error && <span className="sr-only">{error}</span>}
        </div>
      )}
      {(state === "loading" || state === "ready") && data && (
        <div className="branch-groups">
          <div className="branch-group">
            <h4>ローカル</h4>
            {visibleLocal.map((branch) => (
              <BranchRow key={branch.name} branch={branch} onCopy={onCopy} />
            ))}
            {!showMerged && mergedCount > 0 && (
              <button
                className="show-merged"
                type="button"
                onClick={() => onShowMerged(true)}
              >
                merged {mergedCount} 件を表示
              </button>
            )}
            {visibleLocal.length === 0 && mergedCount === 0 && (
              <div className="muted-line">ローカルブランチはありません</div>
            )}
          </div>
          <div className="branch-group">
            <h4>リモート</h4>
            {remote.map((branch) => (
              <BranchRow key={branch.name} branch={branch} onCopy={onCopy} />
            ))}
            {remote.length === 0 && (
              <div className="muted-line">リモートブランチはありません</div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

export default function RepoDetail({
  repo,
  copied,
  onCopy,
  onProjectSelect,
  activeTab,
  onTabChange,
}: RepoDetailProps) {
  const [allRefs, setAllRefs] = useState(false);
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [graphState, setGraphState] = useState<LoadState>("idle");
  const [graphError, setGraphError] = useState<string | null>(null);
  const [graphRetry, setGraphRetry] = useState(0);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const commitLoad = useCommitDetail(repo.path, selectedHash, activeTab === "graph");
  const [branches, setBranches] = useState<BranchesResponse | null>(null);
  const [branchesState, setBranchesState] = useState<LoadState>("idle");
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const [branchesRetry, setBranchesRetry] = useState(0);
  const [showMerged, setShowMerged] = useState(false);

  useEffect(() => {
    setSelectedHash(null);
    setShowMerged(false);
  }, [repo.path]);

  useEffect(() => {
    if (activeTab !== "graph") {
      setGraphState("idle");
      return;
    }
    const controller = new AbortController();
    setGraph(null);
    setGraphState("loading");
    setGraphError(null);
    void getJson<GraphResponse>(
      `/api/repo/graph?${apiQuery(repo.path, { all: String(allRefs), limit: String(GRAPH_LIMIT) })}`,
      controller.signal,
    )
      .then((value) => {
        setGraph(value);
        setGraphState("ready");
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError")
          return;
        setGraphError(
          reason instanceof Error ? reason.message : "unknown error",
        );
        setGraphState("error");
      });
    return () => controller.abort();
  }, [
    activeTab,
    allRefs,
    graphRetry,
    repo.branch,
    repo.last_commit?.hash,
    repo.path,
  ]);

  useEffect(() => {
    if (activeTab !== "branches") {
      setBranchesState("idle");
      return;
    }
    const controller = new AbortController();
    setBranches(null);
    setBranchesState("loading");
    setBranchesError(null);
    void getJson<BranchesResponse>(
      `/api/repo/branches?${apiQuery(repo.path, {})}`,
      controller.signal,
    )
      .then((value) => {
        setBranches(value);
        setBranchesState("ready");
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError")
          return;
        setBranchesError(
          reason instanceof Error ? reason.message : "unknown error",
        );
        setBranchesState("error");
      });
    return () => controller.abort();
  }, [
    activeTab,
    branchesRetry,
    repo.branch,
    repo.last_commit?.hash,
    repo.path,
  ]);

  const virtualNode = useMemo(() => {
    if (
      !graph ||
      !repo.entries?.length ||
      graph.head_lane === null ||
      !repo.branch_line
    )
      return undefined;
    return {
      lane: graph.head_lane,
      label: repo.branch_line,
      summary: (repo.counts ?? [])
        .map((count) => `${display(count.xy)} ${count.count}`)
        .join("  "),
    };
  }, [graph, repo.branch_line, repo.counts, repo.entries]);

  const branchRelationSummary = useMemo(
    () => (graph ? buildBranchRelationSummary(graph) : null),
    [graph],
  );

  return (
    <div className="detail">
      <div className="detail-header">
        <div className="detail-breadcrumb">
          <button className="breadcrumb-project" type="button" onClick={onProjectSelect}>
            {projectName(repo)}
          </button>
          <span>›</span>{" "}
          {repo.branch || (repo.detached ? "detached HEAD" : "本体")}
        </div>
        <div className="detail-path-row">
          <code className="detail-path" title={repo.path}>
            {repo.path}
          </code>
          <button
            className="copy"
            type="button"
            onClick={() => onCopy(repo.path)}
          >
            {copied === repo.path ? "コピーしました" : "パスをコピー"}
          </button>
        </div>
      </div>

      <StatusBlock repo={repo} />
      {repo.next_command && (
        <div className="next">
          <div className="cmdrow">
            <code>{repo.next_command.command}</code>
            <button
              className="copy"
              type="button"
              onClick={() => onCopy(repo.next_command!.command)}
            >
              {copied === repo.next_command.command
                ? "コピーしました"
                : "コピー"}
            </button>
          </div>
          <div className="reason">{repo.next_command.reason}</div>
        </div>
      )}

      <div className="detail-tabs" role="tablist" aria-label="リポジトリ詳細">
        {(["status", "graph", "branches"] as DetailTab[]).map((tab) => (
          <button
            className="detail-tab"
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            onClick={() => onTabChange(tab)}
          >
            {tab === "status"
              ? "状態"
              : tab === "graph"
                ? "グラフ"
                : "ブランチ"}
          </button>
        ))}
      </div>

      {activeTab === "status" && <StatusPane repo={repo} />}

      {activeTab === "graph" && (
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
          {graphState === "loading" && (
            <div
              className="graph-skeletons"
              role="status"
              aria-label="コミットグラフを取得中"
            >
              {[0, 1, 2, 3, 4].map((item) => (
                <div className="graph-skeleton" key={item} />
              ))}
            </div>
          )}
          {graphState === "error" && (
            <div className="inline-error" role="alert">
              コミットグラフを取得できませんでした。
              <button
                className="copy"
                type="button"
                onClick={() => setGraphRetry((value) => value + 1)}
              >
                再取得
              </button>
              {graphError && <span className="sr-only">{graphError}</span>}
            </div>
          )}
          {(graphState === "loading" || graphState === "ready") && graph && (
            <>
              {branchRelationSummary && (
                <BranchRelationSummary summary={branchRelationSummary} />
              )}
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
                <div className="truncated" role="status">
                  {GRAPH_LIMIT} 件まで表示しています。
                </div>
              )}
            </>
          )}
        </section>
      )}

      {activeTab === "graph" && (
        <CommitPane
          detail={commitLoad.detail}
          state={commitLoad.state}
          error={commitLoad.error}
          onRetry={commitLoad.retry}
          onCopy={onCopy}
        />
      )}

      {activeTab === "branches" && (
        <BranchesPane
          data={branches}
          state={branchesState}
          error={branchesError}
          showMerged={showMerged}
          onShowMerged={setShowMerged}
          onRetry={() => setBranchesRetry((value) => value + 1)}
          onCopy={onCopy}
        />
      )}
    </div>
  );
}

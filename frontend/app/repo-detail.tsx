"use client";

import PatchView from "./patch-view";
import { fileStatusDescription, fileStatusGroups } from "./file-status.mjs";

import { useEffect, useMemo, useState } from "react";
import {
  BranchRelationSummary,
  GraphView,
} from "./graph-view";
import { buildBranchRelationSummary } from "./branch-relation.mjs";
import { BranchesResponse, CommitDetail, GraphResponse, Repo } from "./types";
import { codeColor, stateBadges, truncationLabel } from "./status";

export type DetailTab = "status" | "graph" | "branches";

type RepoDetailProps = {
  repo: Repo;
  copied: string | null;
  onCopy: (command: string) => void;
  activeTab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
};

type LoadState = "idle" | "loading" | "ready" | "error";

const GRAPH_LIMIT = 200;
const COMMIT_FETCH_DEBOUNCE_MS = 150;

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
      {badges.some((badge) => badge.token === "clean") && (
        <div className="muted-line">nothing to commit, working tree clean</div>
      )}
    </div>
  );
}

function StatusPane({ repo }: { repo: Repo }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "staged" | "unstaged" | "untracked" | "conflict">("all");
  const filters = [
    { key: "all", label: "すべて" }, { key: "staged", label: "ステージ済み" },
    { key: "unstaged", label: "未ステージ" }, { key: "untracked", label: "未追跡" }, { key: "conflict", label: "競合" },
  ] as const;
  const entries = repo.entries;
  const normalized = query.trim().toLocaleLowerCase();
  const visible = entries?.filter((entry) => fileStatusGroups(entry.xy)[filter] && entry.path.toLocaleLowerCase().includes(normalized));
  return (
    <section className="status-pane" aria-labelledby="status-pane-title">
      <div className="section-head"><h3 id="status-pane-title">変更ファイル</h3><code className="cmdhint">git status --short</code></div>
      {entries === undefined || repo.error || repo.pending ? <div className="inline-error" role="status">変更ファイルの状態は未取得です。{repo.error && <span>{repo.error}。</span>}再走査で最新の状態を取得できます。</div> : <>
        <div className="status-file-tools"><label><span className="sr-only">変更ファイルを検索</span><input type="search" aria-label="変更ファイルを検索" placeholder="ファイル名・パスで検索" value={query} onChange={(event) => setQuery(event.target.value)} /></label><span role="status">{visible?.length} / {entries.length} ファイル</span></div>
        <div className="status-file-filters" role="group" aria-label="変更ファイルの状態で絞り込み">{filters.map(({ key, label }) => <button type="button" key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}<span>{entries.filter((entry) => fileStatusGroups(entry.xy)[key]).length}</span></button>)}</div>
        <div className="status-file-list">
          {visible?.map((entry) => <div className="status-file-row" key={entry.xy + entry.path}><code className="xy" style={{ color: codeColor(entry.xy) }} title={xyTitle(entry.xy)}>{display(entry.xy)}</code><code className="status-file-path">{entry.path}</code><span className="status-file-description">{fileStatusDescription(entry.xy)}</span></div>)}
          {visible?.length === 0 && <div className="status-file-empty">{entries.length === 0 ? "未コミットの変更はありません。" : "条件に一致する変更ファイルはありません。"}{(query || filter !== "all") && <button className="subtle-button" type="button" onClick={() => { setQuery(""); setFilter("all"); }}>絞り込みを解除</button>}</div>}
        </div>
        <details className="status-file-guide"><summary>ステージと状態記号の見方</summary><p>ステージ済みは次のコミットに含める変更、未ステージは作業ディレクトリだけにある変更です。同じファイルに両方の変更がある場合は、それぞれの絞り込みに表示します。</p><p>記号は左がステージ、右が作業ディレクトリです。M: 変更、A: 追加、D: 削除、R: 名前変更、??: 未追跡。競合はファイルを確認して解消します。</p></details>
      </>}
    </section>
  );
}

function CommitPane({
  detail,
  state,
  error,
  onRetry,
  onCopy,
}: {
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
          <button
            className="copy"
            type="button"
            onClick={() => onCopy(detail.command)}
          >
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
            {detail.files.length === 0 && (
              <div className="muted-line">変更ファイルはありません</div>
            )}
          </div>
          <PatchView key={detail.hash} patch={detail.patch} />
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
        <span className="branch-upstream">追跡先 <code>{branch.upstream}</code></span>
      )}
      {branch.track && <span className="branch-track">{branch.track}</span>}
      <time className="branch-date" dateTime={branch.date}>
        {branch.date}
      </time>
      <span className="branch-state">
        {branch.worktree && (
          <span className="branch-worktree" title={branch.worktree}>
            作業場所 · {branch.worktree}
          </span>
        )}
        {abandonedCandidate && (
          <span className="branch-action">
            <span className="branch-abandoned">統合済み · 削除候補</span>
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
          <span className="branch-merged">統合済み</span>
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
          {data ? "ブランチを更新中…" : "ブランチを取得中…"}
        </div>
      )}
      {state === "error" && (
        <div className="inline-error" role="alert">
          {data ? "ブランチを更新できませんでした。前回取得した内容を表示しています。" : "ブランチを取得できませんでした。"}
          <button className="copy" type="button" onClick={onRetry}>
            再取得
          </button>
          {error && <span className="sr-only">{error}</span>}
        </div>
      )}
      {data && (
        <div className="branch-groups">
          <div className="branch-group">
            <h4>ローカル</h4>
            {visibleLocal.map((branch) => (
              <BranchRow key={branch.name} branch={branch} onCopy={onCopy} />
            ))}
            {mergedCount > 0 && (
              <button
                className="show-merged"
                type="button"
                onClick={() => onShowMerged(!showMerged)}
              >
                {showMerged ? "統合済みを折りたたむ" : `統合済み ${mergedCount} 件を表示`}
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
  activeTab,
  onTabChange,
}: RepoDetailProps) {
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
    setBranches(null);
  }, [repo.path]);

  useEffect(() => {
    setGraph(null);
  }, [repo.path, allRefs]);

  useEffect(() => {
    if (activeTab !== "graph") {
      setGraphState("idle");
      return;
    }
    const controller = new AbortController();
    setGraphState("loading");
    setGraphError(null);
    void getJson<GraphResponse>(
      `/api/repo/graph?${apiQuery(repo.path, { all: String(allRefs), limit: String(GRAPH_LIMIT) })}`,
      controller.signal,
    )
      .then((value) => {
          if (controller.signal.aborted) return;
        setGraph(value);
        setGraphState("ready");
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted)
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
    repo.checked_at,
    repo.path,
  ]);

  useEffect(() => {
    if (activeTab !== "branches") {
      setBranchesState("idle");
      return;
    }
    const controller = new AbortController();
    setBranchesState("loading");
    setBranchesError(null);
    void getJson<BranchesResponse>(
      `/api/repo/branches?${apiQuery(repo.path, {})}`,
      controller.signal,
    )
      .then((value) => {
          if (controller.signal.aborted) return;
        setBranches(value);
        setBranchesState("ready");
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted)
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
    repo.checked_at,
    repo.path,
  ]);

  useEffect(() => {
    if (activeTab !== "graph") {
      setCommit(null);
      setCommitState("idle");
      return;
    }
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
      )
        .then((value) => {
          if (controller.signal.aborted) return;
          setCommit(value);
          setCommitState("ready");
        })
        .catch((reason: unknown) => {
          if (controller.signal.aborted)
            return;
          setCommitError(
            reason instanceof Error ? reason.message : "unknown error",
          );
          setCommitState("error");
        });
    }, COMMIT_FETCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [activeTab, repo.path, selectedHash, commitRetry]);

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
          {projectName(repo)} <span>›</span>{" "}
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
            id={`repo-tab-${tab}`}
            aria-controls={`repo-panel-${tab}`}
            tabIndex={activeTab === tab ? 0 : -1}
            onKeyDown={(event) => {
              const tabs: DetailTab[] = ["status", "graph", "branches"];
              const index = tabs.indexOf(tab);
              const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
              if (next === null) return;
              event.preventDefault();
              onTabChange(tabs[next]);
              document.getElementById(`repo-tab-${tabs[next]}`)?.focus();
            }}
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

      <div role="tabpanel" id={`repo-panel-${activeTab}`} aria-labelledby={`repo-tab-${activeTab}`} tabIndex={0}>
      {activeTab === "status" && <StatusPane key={repo.path} repo={repo} />}

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
          {graphState === "loading" && !graph && (
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
          {graphState === "loading" && graph && <div className="muted-line" role="status">コミットグラフを更新中…</div>}
          {graphState === "error" && (
            <div className="inline-error" role="alert">
              {graph ? "コミットグラフを更新できませんでした。前回取得した内容を表示しています。" : "コミットグラフを取得できませんでした。"}
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
          {graph && (
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
          detail={commit}
          state={commitState}
          error={commitError}
          onRetry={() => setCommitRetry((value) => value + 1)}
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
    </div>
  );
}

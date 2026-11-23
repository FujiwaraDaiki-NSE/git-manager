"use client";
import { statusDiffStages, hasNoUncommittedChanges, responseErrorMessage } from "./repo-detail-tools.mjs";
import { OperationFacts } from "./git-state-facts";

import PatchView from "./patch-view";
import CommitFiles from "./commit-files";
import ConflictInspector from "./conflict-inspector";
import CopyButton from "./copy-button";
import { buildInvestigationShareUrl } from "./investigation-presets-tools.mjs";
import { commandTarget, worktreeCommand } from "./next-command-tools.mjs";
import Submodules from "./submodules";
import { fileStatusDescription, fileStatusGroups } from "./file-status.mjs";
import {
  BRANCH_FILTERS,
  BRANCH_SORTS,
  changedPathList,
  visibleBranches,
} from "./repo-tools.mjs";
import {
  STATUS_FILE_DIRECTORY_ALL,
  STATUS_FILE_DIRECTORY_ROOT,
  STATUS_FILE_EXTENSION_ALL,
  STATUS_FILE_EXTENSION_NONE,
  shellQuote,
  buildStatusDiffCommands,
  buildStatusStageCommands,
  filterStatusFilesByDirectory,
  filterStatusFilesByExtension,
  listStatusFileDirectories,
  listStatusFileExtensions,
  searchStatusFiles,
  sortStatusFiles,
  statusFilesCsv,
  statusStagePaths,
} from "./status-file-tools.mjs";
import WorktreeDiff, { type WorktreeDiffStage } from "./worktree-diff";
import "./repo-tools.css";
import "./status-file-tools.css";

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
  repos: ReadonlyMap<string, Repo>;
  onOpenWorktree: (path: string) => void;
  repo: Repo;
  copied: string | null;
  onCopy: (command: string) => void;
  activeTab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
};

type LoadState = "idle" | "loading" | "ready" | "error";
type BranchFilter = "all" | "current" | "worktree" | "untracked-upstream";
type BranchSort = "name" | "date";
type StatusFileFilter = "all" | "staged" | "unstaged" | "untracked" | "conflict";
type StatusFileOrder = "asc" | "desc";

const GRAPH_LIMIT_STEP = 200;
// Keep in sync with backend/app/main.py MAX_GRAPH_LIMIT.
const MAX_GRAPH_LIMIT = 2_000;
const COMMIT_FETCH_DEBOUNCE_MS = 150;

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store", signal });
  } catch (reason) {
    if (signal.aborted) throw reason;
    throw new Error("通信に失敗しました。");
  }
  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // JSON本文がない場合は、確認できたHTTPステータスを表示する。
    }
    throw new Error(responseErrorMessage(response.status, body));
  }
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
      <OperationFacts operations={repo.operations} />
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
      {hasNoUncommittedChanges(repo) && (
        <div className="muted-line">未コミットの変更なし</div>
      )}
    </div>
  );
}

function StatusPane({ repo }: { repo: Repo }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<StatusFileFilter>("all");
  const [directory, setDirectory] = useState<string>(STATUS_FILE_DIRECTORY_ALL);
  const [extension, setExtension] = useState<string>(STATUS_FILE_EXTENSION_ALL);
  const [order, setOrder] = useState<StatusFileOrder>("asc");
  const [diffStage, setDiffStage] = useState<WorktreeDiffStage>("unstaged");
  const [selectedDiffFile, setSelectedDiffFile] = useState<string | null>(null);
  const [selectedStageFiles, setSelectedStageFiles] = useState<Set<string>>(() => new Set());
  const [downloadStatus, setDownloadStatus] = useState<"idle" | "success" | "error">("idle");
  const filters: { key: StatusFileFilter; label: string }[] = [
    { key: "all", label: "すべて" }, { key: "staged", label: "ステージ済み" },
    { key: "unstaged", label: "未ステージ" }, { key: "untracked", label: "未追跡" }, { key: "conflict", label: "競合" },
  ];
  const entries = repo.entries;
  const availableEntries = entries ?? [];
  const directoryOptions = useMemo(
    () => entries === undefined ? [] : listStatusFileDirectories(entries),
    [entries],
  );
  const extensionOptions = useMemo(
    () => entries === undefined ? [] : listStatusFileExtensions(entries),
    [entries],
  );
  const visible = useMemo(() => {
    const searched = searchStatusFiles(availableEntries, query);
    const byDirectory = filterStatusFilesByDirectory(searched, directory);
    const byExtension = filterStatusFilesByExtension(byDirectory, extension);
    const byStatus = byExtension.filter((entry) => fileStatusGroups(entry.xy)[filter]);
    return sortStatusFiles(byStatus, order);
  }, [availableEntries, directory, extension, filter, order, query]);
  const diffCommands = useMemo(
    () => entries === undefined ? null : buildStatusDiffCommands(repo.path, visible),
    [entries, repo.path, visible],
  );
  const stageFileKey = (entry: NonNullable<Repo["entries"]>[number]) =>
    JSON.stringify([entry.path, entry.original_path, entry.xy]);
  const stageFiles = visible.filter((entry) => statusStagePaths(entry).length > 0 && selectedStageFiles.has(stageFileKey(entry)));
  const stageCommands = buildStatusStageCommands(repo.path, stageFiles);
  const excluded = diffCommands?.excluded;
  const hasMissingOriginalPath = visible.some((entry) => /[RC]/.test(entry.xy) && entry.original_path === null);
  const exclusionParts = excluded === undefined ? [] : [
    excluded.untracked.length > 0 ? `未追跡 ${excluded.untracked.length} 件` : null,
    excluded.conflicts.length > 0 ? `競合 ${excluded.conflicts.length} 件` : null,
    excluded.unsupported.length > 0 ? `未対応の状態 ${excluded.unsupported.length} 件` : null,
  ].filter((part): part is string => part !== null);
  const hasFilters = query.trim().length > 0
    || filter !== "all"
    || directory !== STATUS_FILE_DIRECTORY_ALL
    || extension !== STATUS_FILE_EXTENSION_ALL
    || order !== "asc";
  const clearFilters = () => {
    setQuery("");
    setFilter("all");
    setDirectory(STATUS_FILE_DIRECTORY_ALL);
    setExtension(STATUS_FILE_EXTENSION_ALL);
    setOrder("asc");
  };
  const exportCsv = () => {
    try {
      const blob = new Blob([statusFilesCsv(visible)], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${repo.name}-status.csv`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDownloadStatus("success");
    } catch {
      setDownloadStatus("error");
    }
  };
  return (
    <section className="status-pane" aria-labelledby="status-pane-title">
      <div className="section-head"><h3 id="status-pane-title">変更ファイル</h3><code className="cmdhint">git status --short</code></div>
      {entries === undefined || repo.error || repo.pending ? <div className="inline-error" role="status">
        <span>変更ファイルの状態は未取得です。</span>
        {repo.error && <span className="git-status-error-reason">{repo.error}</span>}
        <span>再走査で最新の状態を取得できます。</span>
      </div> : <>
        <div className="status-file-tools-panel">
          <div className="status-file-tools-controls" aria-label="変更ファイルの表示条件">
            <label className="status-file-search"><span>変更ファイルを検索</span><input type="search" aria-label="変更ファイルを検索" placeholder="ファイル名・パスで検索" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
            <label><span>ディレクトリ</span><select aria-label="変更ファイルをディレクトリで絞り込み" value={directory} onChange={(event) => setDirectory(event.target.value)}><option value={STATUS_FILE_DIRECTORY_ALL}>すべて</option>{directoryOptions.map((item) => <option key={item} value={item}>{item === STATUS_FILE_DIRECTORY_ROOT ? "ルート" : item}</option>)}</select></label>
            <label><span>拡張子</span><select aria-label="変更ファイルを拡張子で絞り込み" value={extension} onChange={(event) => setExtension(event.target.value)}><option value={STATUS_FILE_EXTENSION_ALL}>すべて</option>{extensionOptions.map((item) => <option key={item} value={item}>{item === STATUS_FILE_EXTENSION_NONE ? "拡張子なし" : item}</option>)}</select></label>
            <button className="status-file-order" type="button" onClick={() => setOrder((value) => value === "asc" ? "desc" : "asc")} aria-label={`パス順を${order === "asc" ? "降順" : "昇順"}に変更`} title={`現在はパス${order === "asc" ? "昇順" : "降順"}`}>{order === "asc" ? "パス順 ↑" : "パス順 ↓"}</button>
          </div>
          <div className="status-file-tools-summary">
            <span role="status">{visible.length} / {entries.length} ファイル</span>
            {visible.length > 0 && <CopyButton value={changedPathList(visible)} label="表示中のパスをコピー" />}
            <button className="status-file-export" type="button" onClick={exportCsv} disabled={visible.length === 0} aria-label={`表示中の${visible.length}件をCSVで保存`}>表示中をCSV保存</button>
            <button className="status-file-reset" type="button" onClick={clearFilters} disabled={!hasFilters}>絞り込みを解除</button>
            <span className={`status-file-download-status${downloadStatus === "error" ? " is-error" : ""}`} role={downloadStatus === "error" ? "alert" : "status"} aria-live="polite">{downloadStatus === "success" ? "CSVの保存を開始しました。" : downloadStatus === "error" ? "CSVを保存できませんでした。" : ""}</span>
          </div>
        </div>
        <div className="status-file-filters" role="group" aria-label="変更ファイルの状態で絞り込み">{filters.map(({ key, label }) => <button type="button" key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}<span>{entries.filter((entry) => fileStatusGroups(entry.xy)[key]).length}</span></button>)}</div>
        <div className="status-file-list">
          {visible.map((entry) => {
            const rowStages = statusDiffStages(entry.xy, filter);
            const stageKey = stageFileKey(entry);
            const canSelectStage = statusStagePaths(entry).length > 0;
            return <div className="status-file-row" key={entry.xy + entry.path}>
              <code className="xy" style={{ color: codeColor(entry.xy) }} title={xyTitle(entry.xy)}>{display(entry.xy)}</code>
              <label className="status-file-path">
                {canSelectStage && <input
                  type="checkbox"
                  aria-label={`${entry.path} をステージ対象に選択`}
                  checked={selectedStageFiles.has(stageKey)}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setSelectedStageFiles((previous) => {
                      const next = new Set(previous);
                      if (checked) next.add(stageKey);
                      else next.delete(stageKey);
                      return next;
                    });
                  }}
                />}
                <code>{entry.original_path !== null && <>{entry.original_path} → </>}{entry.path}</code>
              </label>
              <span className="status-file-description">{fileStatusDescription(entry.xy)}</span>
              <span className="status-file-copy"><CopyButton value={entry.path} label={`${entry.path} のパスをコピー`} /></span>
              {rowStages.length > 0
                ? rowStages.map((stage) => <button key={stage} className="status-file-diff-button" type="button" onClick={() => { setDiffStage(stage); setSelectedDiffFile(entry.path); }}>{rowStages.length === 1 ? "差分を表示" : stage === "staged" ? "ステージ済み差分" : "未ステージ差分"}</button>)
                : <span className="status-file-diff-excluded">差分対象外</span>}
            </div>;
          })}
          {visible.length === 0 && <div className="status-file-empty">{hasNoUncommittedChanges(repo) ? "未コミットの変更なし" : "条件に一致する変更ファイルはありません。"}{hasFilters && <button className="subtle-button" type="button" onClick={clearFilters}>絞り込みを解除</button>}</div>}
        </div>
        {entries.some((entry) => statusStagePaths(entry).length > 0 || (entry.xy === "??" && entry.path.endsWith("/"))) && (
          <div className="status-file-command-copy" aria-label="ステージするコマンド">
            <h4>選んだファイルをステージ</h4>
            <p role="status">表示中の選択 {stageFiles.length} 件</p>
            {visible.some((entry) => entry.xy === "??" && entry.path.endsWith("/")) && (
              <p className="status-file-diff-note">未追跡ディレクトリの行は、中のファイルを個別に選べないため対象外です。</p>
            )}
            {stageCommands !== null && <>
              <div className="status-file-diff-command"><code>{stageCommands.dryRun}</code><CopyButton value={stageCommands.dryRun} label="ステージの dry-run コマンドをコピー" /></div>
              <div className="status-file-diff-command"><code>{stageCommands.add}</code><CopyButton value={stageCommands.add} label="ステージするコマンドをコピー" /></div>
            </>}
          </div>
        )}
        {entries.some((entry) => fileStatusGroups(entry.xy).conflict) && <ConflictInspector path={repo.path} />}
        {entries.length > 0 && <div className="status-file-diff-tools" aria-labelledby="status-file-diff-title">
          <div className="status-file-diff-heading">
            <div>
              <h4 id="status-file-diff-title">追跡ファイルの差分を確認</h4>
              <p className="status-file-diff-empty">Gitの状態を変更せず、ステージと作業ツリーを別々に表示します。</p>
            </div>
            <button className="status-file-show-all" type="button" onClick={() => setSelectedDiffFile(null)} aria-pressed={selectedDiffFile === null}>全体の差分を表示</button>
          </div>
          <div className="status-file-stage-switch" role="group" aria-label="差分の段階">
            <button type="button" aria-pressed={diffStage === "staged"} onClick={() => setDiffStage("staged")}>ステージ済み</button>
            <button type="button" aria-pressed={diffStage === "unstaged"} onClick={() => setDiffStage("unstaged")}>未ステージ</button>
            <span>{selectedDiffFile === null ? "表示範囲: 全体" : <>表示範囲: <code>{selectedDiffFile}</code></>}</span>
          </div>
          <p className="status-file-diff-note" role="note">未追跡ファイルと競合はこの差分表示の対象外です。各行の「差分を表示」からファイル単位を開けます。名前変更・コピーは元と先のパスをまとめて表示します。</p>
          <div className="status-file-command-copy">
            <h5>表示中の追跡ファイルの差分コマンド</h5>
            <p className="status-file-diff-empty">コマンドはコピー専用です。この画面では実行しません。</p>
            <div className="status-file-diff-command"><code>{diffCommands?.staged ?? "ステージ済みの差分はありません。"}</code>{diffCommands?.staged && <CopyButton value={diffCommands.staged} label="ステージ済みの差分コマンドをコピー" />}</div>
            <div className="status-file-diff-command"><code>{diffCommands?.unstaged ?? "未ステージの差分はありません。"}</code>{diffCommands?.unstaged && <CopyButton value={diffCommands.unstaged} label="未ステージの差分コマンドをコピー" />}</div>
            {exclusionParts.length > 0 && <p className="status-file-diff-note" role="status">{exclusionParts.join("、")}は差分コマンドから除外しました。未追跡ファイルはGitの差分対象外で、競合と未対応の状態は安全に対象を確定できないためです。</p>}
            {hasMissingOriginalPath && <p className="status-file-diff-note" role="status">名前変更・コピーは元のパスが未取得のため、差分コマンドから除外しています。名前変更前後の差分はターミナルで確認してください。</p>}
          </div>
          <WorktreeDiff path={repo.path} file={selectedDiffFile} stage={diffStage} />
        </div>}
        <details className="status-file-guide"><summary>ステージと状態記号の見方</summary><div className="status-flow" aria-label="作業ディレクトリからステージ、コミットへの流れ"><div className="status-flow-node"><strong>作業ディレクトリ</strong><span>未ステージ</span><code>git diff</code></div><div className="status-flow-arrow"><code>git add</code><span aria-hidden="true">→</span></div><div className="status-flow-node"><strong>ステージ（index）</strong><span>ステージ済み</span><code>git diff --cached</code></div><div className="status-flow-arrow"><code>git commit</code><span aria-hidden="true">→</span></div><div className="status-flow-node"><strong>コミット</strong><span>履歴に保存</span></div></div><p>ステージ済みは次のコミットに含める変更、未ステージは作業ディレクトリだけにある変更です。同じファイルに両方の変更がある場合は、それぞれの絞り込みに表示します。</p><p>記号は左がステージ、右が作業ディレクトリです。M: 変更、A: 追加、D: 削除、R: 名前変更、??: 未追跡。競合はファイルを確認して解消します。</p></details>
      </>}
    </section>
  );
}

function CommitPane({
  detail,
  repoPath,
  state,
  error,
  onRetry,
  onCopy,
}: {
  detail: CommitDetail | null;
  repoPath: string;
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
          {error && <span>{error}</span>}
        </div>
      )}
      {state === "ready" && detail && (
        <>
          <div className="commit-meta">
            <strong>{detail.subject || "(no subject)"}</strong>
            <span>{detail.author}</span>
            <span>{detail.date}</span>
          </div>
          {detail.parents.length > 1 && (
            <div className="commit-meta">
              {detail.parents.map((parent, index) => (
                <a
                  key={`${index}:${parent}`}
                  className="copy"
                  href={buildInvestigationShareUrl(`/project?${apiQuery(repoPath, { tab: "info" })}`, "compare", {
                    base: parent,
                    target: detail.hash,
                    mode: "direct",
                  })}
                >
                  第{index + 1}親との差分（{parent.slice(0, 7)}）
                </a>
              ))}
            </div>
          )}
          <CommitFiles key={detail.hash} files={detail.files} downloadName={`${detail.hash}-files.tsv`} />
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
  repo,
  repos,
  onOpenWorktree,
  branch,
  onCopy,
}: {
  repo: Repo;
  repos: ReadonlyMap<string, Repo>;
  onOpenWorktree: (path: string) => void;
  branch: BranchesResponse["local"][number];
  onCopy: (command: string) => void;
}) {
  const collapsedMerged = branch.merged && !branch.current;
  const abandonedCandidate = collapsedMerged && !branch.worktree && !branch.is_default;
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
      <time className="branch-date" dateTime={branch.date || undefined}>
        {branch.date || "日付未取得"}
      </time>
      <span className="branch-state">
        {branch.worktree && (
          <span className="branch-worktree" title={branch.worktree}>
            作業場所 · {branch.worktree}
            {branch.worktree === repo.path ? (
              <span>表示中</span>
            ) : repos.has(branch.worktree) ? (
              <button className="copy" type="button" onClick={() => onOpenWorktree(branch.worktree!)}>
                このworktreeのGit詳細
              </button>
            ) : (
              <span>リポジトリ情報が未取得のためGit詳細を開けません</span>
            )}
          </span>
        )}
        {abandonedCandidate && (
          <span className="branch-action">
            <span className="branch-abandoned">統合済み · 削除候補</span>
            <span className="branch-command-target">実行先 · <code>{repo.path}</code></span>
            <button
              className="branch-delete"
              type="button"
              onClick={() => onCopy(worktreeCommand(`git branch -d ${shellQuote(branch.name)}`, repo.path, repo.common_dir))}
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
  repo,
  repos,
  onOpenWorktree,
  data,
  state,
  error,
  showMerged,
  onShowMerged,
  onRetry,
  onCopy,
}: {
  repo: Repo;
  repos: ReadonlyMap<string, Repo>;
  onOpenWorktree: (path: string) => void;
  data: BranchesResponse | null;
  state: LoadState;
  error: string | null;
  showMerged: boolean;
  onShowMerged: (show: boolean) => void;
  onRetry: () => void;
  onCopy: (command: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<BranchFilter>("all");
  const [sort, setSort] = useState<BranchSort>("name");
  if (state === "idle") return null;
  const local = data?.local ?? [];
  const remote = data?.remotes ?? [];
  const branchOptions = { query, filter, showMerged, sort } as const;
  // A merged branch checked out in another worktree remains active and must
  // stay visible in the default view.
  const visibleLocal = visibleBranches(local, branchOptions);
  const visibleRemote = visibleBranches(remote, branchOptions);
  const resultCount = visibleLocal.length + visibleRemote.length;
  const totalCount = local.length + remote.length;
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
          {error && <span>{error}</span>}
        </div>
      )}
      {data && (
        <>
          <div className="repo-tools-toolbar" aria-label="ブランチの表示条件">
            <label className="repo-tools-search">
              ブランチを検索
              <input
                type="search"
                aria-label="ブランチ名・追跡先・作業場所を検索"
                placeholder="名前・追跡先・作業場所"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <label>
              並び順
              <select aria-label="ブランチの並び順" value={sort} onChange={(event) => setSort(event.target.value as BranchSort)}>
                {BRANCH_SORTS.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
              </select>
            </label>
            <span className="repo-tools-count" role="status">{resultCount} / {totalCount} ブランチ</span>
            <button className="repo-tools-reset" type="button" disabled={!query.trim()} onClick={() => setQuery("")}>検索をリセット</button>
          </div>
          <div className="branch-filter-list" role="group" aria-label="ブランチの種類で絞り込み">
            {BRANCH_FILTERS.map((option) => {
              const optionFilter = option.key as BranchFilter;
              const count = visibleBranches(local, { query, filter: optionFilter, showMerged, sort }).length
                + visibleBranches(remote, { query, filter: optionFilter, showMerged, sort }).length;
              return <button key={option.key} type="button" aria-pressed={filter === optionFilter} onClick={() => setFilter(optionFilter)}>{option.label}<span>{count}</span></button>;
            })}
          </div>
          <div className="branch-groups">
          <div className="branch-group">
            <h4>ローカル</h4>
            {visibleLocal.map((branch) => (
              <BranchRow key={branch.name} branch={branch} repo={repo} repos={repos} onOpenWorktree={onOpenWorktree} onCopy={onCopy} />
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
              <div className="muted-line">{local.length === 0 ? "ローカルブランチはありません" : "条件に一致するローカルブランチはありません"}</div>
            )}
          </div>
          <div className="branch-group">
            <h4>リモート</h4>
            {visibleRemote.map((branch) => (
              <BranchRow key={branch.name} branch={branch} repo={repo} repos={repos} onOpenWorktree={onOpenWorktree} onCopy={onCopy} />
            ))}
            {visibleRemote.length === 0 && (
              <div className="muted-line">{remote.length === 0 ? "リモートブランチはありません" : "条件に一致するリモートブランチはありません"}</div>
            )}
          </div>
          </div>
        </>
      )}
    </section>
  );
}

export default function RepoDetail({
  repos,
  onOpenWorktree,
  repo,
  copied,
  onCopy,
  activeTab,
  onTabChange,
}: RepoDetailProps) {
  const nextCommand = repo.next_command == null ? null : worktreeCommand(repo.next_command.command, repo.path, repo.common_dir);
  const nextTarget = repo.next_command == null ? null : commandTarget(repo.next_command.command, repo.path, repo.common_dir);
  const [allRefs, setAllRefs] = useState(false);
  const [graphLimit, setGraphLimit] = useState(GRAPH_LIMIT_STEP);
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
    setGraphLimit(GRAPH_LIMIT_STEP);
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
      `/api/repo/graph?${apiQuery(repo.path, { all: String(allRefs), limit: String(graphLimit) })}`,
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
    graphLimit,
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
      label: `未コミット変更 · ${repo.branch_line}`,
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
      {repo.next_command && nextCommand !== null && (
        <div className="next">
          <div className="cmdrow">
            <code>{nextCommand}</code>
            <button
              className="copy"
              type="button"
              onClick={() => onCopy(nextCommand)}
            >
              {copied === nextCommand
                ? "コピーしました"
                : "コピー"}
            </button>
            <small>実行先: {nextTarget === null ? "未取得" : nextTarget === repo.path ? `${repo.branch == null ? "ブランチ未取得" : repo.branch} · ${repo.path}` : `メインのチェックアウト · ${nextTarget}`}</small>
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
      {activeTab === "status" && <><StatusPane key={repo.path} repo={repo} /><Submodules key={repo.path} repo={repo} /></>}

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
              {graphError && <span>{graphError}</span>}
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
                  onVirtualSelect={() => {
                    onTabChange("status");
                    document.getElementById("repo-tab-status")?.focus();
                  }}
                  virtualNode={virtualNode}
                />
              ) : (
                <div className="muted-line">コミットがありません</div>
              )}
              {(graph.truncated || graph.rows.length >= MAX_GRAPH_LIMIT) && (
                <div className="truncated" role="status">
                  {graph.rows.length} 件まで表示しています。
                  {graph.rows.length >= MAX_GRAPH_LIMIT ? (
                    <span>表示上限の {MAX_GRAPH_LIMIT.toLocaleString()} 件に達しました。</span>
                  ) : (
                    <button
                      type="button"
                      disabled={graphState === "loading"}
                      onClick={() => setGraphLimit(Math.min(graph.rows.length + GRAPH_LIMIT_STEP, MAX_GRAPH_LIMIT))}
                    >
                      さらに表示（+{Math.min(GRAPH_LIMIT_STEP, MAX_GRAPH_LIMIT - graph.rows.length)}件）
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      )}

      {activeTab === "graph" && (
        <CommitPane
          detail={commit}
          repoPath={repo.path}
          state={commitState}
          error={commitError}
          onRetry={() => setCommitRetry((value) => value + 1)}
          onCopy={onCopy}
        />
      )}

      {activeTab === "branches" && (
        <BranchesPane
          repo={repo}
          repos={repos}
          onOpenWorktree={onOpenWorktree}
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

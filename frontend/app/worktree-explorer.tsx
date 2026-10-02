"use client";

import { useMemo, useState } from "react";
import CopyButton from "./copy-button";
import type { ProjectLane, ProjectResponse } from "./types";
import {
  basename,
  buildWorktreeInventory,
  filterWorktreeInventory,
  sortWorktreeInventory,
  summarizeWorktreeInventory,
  worktreeCdCommand,
  worktreeHealth,
  worktreeHealthTokens,
  worktreeInventoryTsv,
  worktreeState,
  worktreeStateTokens,
} from "./worktree-tools.mjs";

type WorktreeStateFilter = "all" | "main" | "ok" | "detached" | "prunable" | "locked" | "unknown";
type WorktreeHealthFilter = "all" | "dirty" | "conflict" | "clean" | "unknown";
type WorktreeOrder = "status" | "branch" | "path";
type WorktreeInventoryRow = {
  worktree: ProjectResponse["worktrees"][number];
  lane: ProjectLane | null;
};

export type WorktreeExplorerProps = {
  project: ProjectResponse;
  onOpenGit: (lane: ProjectLane) => void;
  onSelectLane: (lane: ProjectLane) => void;
};

const stateFilters: Array<{ key: WorktreeStateFilter; label: string }> = [
  { key: "all", label: "すべて" },
  { key: "main", label: "メイン作業場所" },
  { key: "ok", label: "利用可能" },
  { key: "detached", label: "detached" },
  { key: "prunable", label: "参照先なし" },
  { key: "locked", label: "ロック中" },
  { key: "unknown", label: "状態未取得" },
];

const healthFilters: Array<{ key: WorktreeHealthFilter; label: string }> = [
  { key: "all", label: "すべて" },
  { key: "dirty", label: "変更あり" },
  { key: "conflict", label: "競合" },
  { key: "clean", label: "変更なし" },
  { key: "unknown", label: "未取得" },
];

const orderOptions: Array<{ key: WorktreeOrder; label: string }> = [
  { key: "status", label: "状態順" },
  { key: "branch", label: "ブランチ順" },
  { key: "path", label: "パス順" },
];

function stateLabel(state: string) {
  switch (state) {
    case "main": return "メイン作業場所";
    case "ok": return "利用可能";
    case "detached": return "detached";
    case "prunable": return "参照先なし";
    case "locked": return "ロック中";
    default: return "状態未取得";
  }
}

function healthLabel(health: string) {
  switch (health) {
    case "dirty": return "変更あり";
    case "conflict": return "競合";
    case "clean": return "変更なし";
    default: return "未取得";
  }
}

function branchLabel(row: WorktreeInventoryRow) {
  if (typeof row.worktree.branch === "string" && row.worktree.branch.length > 0) return row.worktree.branch;
  if (row.worktree.detached === true) return "detached HEAD";
  return "ブランチ未取得";
}

function headLabel(row: WorktreeInventoryRow) {
  if (typeof row.worktree.head !== "string" || row.worktree.head.length === 0) return "HEAD 未取得";
  return row.worktree.head.slice(0, 10);
}

function downloadTsv(projectName: string, value: string) {
  const blob = new Blob([value], { type: "text/tab-separated-values;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const safeName = projectName.replace(/[^A-Za-z0-9._-]+/g, "-");
  anchor.href = url;
  anchor.download = `${safeName}-worktrees.tsv`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function SummaryMetric({
  label,
  value,
  tone,
  onClick,
  pressed,
}: {
  label: string;
  value: number;
  tone?: string;
  onClick?: () => void;
  pressed?: boolean;
}) {
  const content = <><span className="worktree-explorer-metric-label">{label}</span><strong>{value}</strong></>;
  if (!onClick) return <div className={`worktree-explorer-metric${tone ? ` is-${tone}` : ""}`}>{content}</div>;
  return <button className={`worktree-explorer-metric${tone ? ` is-${tone}` : ""}`} type="button" aria-pressed={pressed} onClick={onClick}>{content}</button>;
}

export default function WorktreeExplorer({ project, onOpenGit, onSelectLane }: WorktreeExplorerProps) {
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<WorktreeStateFilter>("all");
  const [healthFilter, setHealthFilter] = useState<WorktreeHealthFilter>("all");
  const [order, setOrder] = useState<WorktreeOrder>("status");

  const inventory = useMemo<WorktreeInventoryRow[]>(() => buildWorktreeInventory(project), [project]);
  const summary = useMemo(() => summarizeWorktreeInventory(inventory), [inventory]);
  const visible = useMemo(() => {
    const filtered = filterWorktreeInventory(inventory, {
      query,
      state: stateFilter,
      health: healthFilter,
    });
    return sortWorktreeInventory(filtered, order);
  }, [healthFilter, inventory, order, query, stateFilter]);

  const exportVisible = () => {
    if (visible.length === 0) return;
    downloadTsv(project.name, worktreeInventoryTsv(visible));
  };

  return (
    <section className="worktree-explorer" aria-labelledby="worktree-explorer-title">
      <header className="worktree-explorer-heading">
        <div>
          <p className="worktree-explorer-kicker">WORKTREE INVENTORY</p>
          <h2 id="worktree-explorer-title">作業ツリーの一覧</h2>
          <code className="worktree-explorer-project-path" title={project.main_path}>{project.main_path}</code>
        </div>
        <div className="worktree-explorer-heading-actions">
          <span className="worktree-explorer-result-count" role="status">{visible.length} / {summary.total} 件</span>
          <button className="worktree-explorer-export" type="button" disabled={visible.length === 0} onClick={exportVisible}>
            TSVを書き出す
          </button>
        </div>
      </header>

      <div className="worktree-explorer-summary" aria-label="作業ツリー集計">
        <SummaryMetric label="worktree" value={summary.total} tone="total" onClick={() => { setStateFilter("all"); setHealthFilter("all"); }} pressed={stateFilter === "all" && healthFilter === "all"} />
        <SummaryMetric label="メイン作業場所" value={summary.main} tone="main" onClick={() => { setStateFilter("main"); setHealthFilter("all"); }} pressed={stateFilter === "main" && healthFilter === "all"} />
        <SummaryMetric label="変更あり" value={summary.dirty} tone="dirty" onClick={() => { setHealthFilter("dirty"); setStateFilter("all"); }} pressed={healthFilter === "dirty" && stateFilter === "all"} />
        <SummaryMetric label="競合" value={summary.conflict} tone="conflict" onClick={() => { setHealthFilter("conflict"); setStateFilter("all"); }} pressed={healthFilter === "conflict" && stateFilter === "all"} />
        <SummaryMetric label="参照先なし" value={summary.prunable} tone="prunable" onClick={() => { setStateFilter("prunable"); setHealthFilter("all"); }} pressed={stateFilter === "prunable" && healthFilter === "all"} />
        <SummaryMetric label="状態未取得" value={summary.unknown} tone="unknown" onClick={() => { setStateFilter("unknown"); setHealthFilter("all"); }} pressed={stateFilter === "unknown" && healthFilter === "all"} />
      </div>

      <div className="worktree-explorer-toolbar">
        <label className="worktree-explorer-search">
          <span className="sr-only">作業ツリーを検索</span>
          <input type="search" value={query} placeholder="パス・ブランチ・作業ブランチを検索" onChange={(event) => setQuery(event.target.value)} />
        </label>
        <label className="worktree-explorer-order">
          <span>並び順</span>
          <select value={order} onChange={(event) => setOrder(event.target.value as WorktreeOrder)}>
            {orderOptions.map((option) => <option value={option.key} key={option.key}>{option.label}</option>)}
          </select>
        </label>
      </div>

      <div className="worktree-explorer-filters">
        <div className="worktree-explorer-filter-group" role="group" aria-label="worktree の状態で絞り込み">
          <span className="worktree-explorer-filter-title">Git worktree</span>
          {stateFilters.map((option) => <button type="button" key={option.key} aria-pressed={stateFilter === option.key} onClick={() => setStateFilter(option.key)}>{option.label}</button>)}
        </div>
        <div className="worktree-explorer-filter-group" role="group" aria-label="Git の変更状態で絞り込み">
          <span className="worktree-explorer-filter-title">Git 状態</span>
          {healthFilters.map((option) => <button type="button" key={option.key} aria-pressed={healthFilter === option.key} onClick={() => setHealthFilter(option.key)}>{option.label}</button>)}
        </div>
      </div>

      <div className="worktree-explorer-list" aria-live="polite">
        {visible.map((row: WorktreeInventoryRow, index: number) => {
          const state = worktreeState(row.worktree);
          const health = worktreeHealth(row);
          const healthTokens = worktreeHealthTokens(row);
          const tokens = worktreeStateTokens(row.worktree);
          const cd = worktreeCdCommand(row.worktree.path);
          const lane = row.lane;
          return (
            <article className={`worktree-explorer-card state-${state} health-${health}`} key={`${row.worktree.path}:${index}`}>
              <div className="worktree-explorer-card-marker" aria-hidden="true" />
              <div className="worktree-explorer-card-main">
                <div className="worktree-explorer-card-topline">
                  <div className="worktree-explorer-state-badges" aria-label="worktree の状態">
                    {tokens.map((token: string) => <span className={`worktree-explorer-state state-${token}`} key={token}>{stateLabel(token)}</span>)}
                    {healthTokens.map((token: string) => <span className={`worktree-explorer-health health-${token}`} key={token}>{healthLabel(token)}</span>)}
                  </div>
                  <span className="worktree-explorer-basename">{basename(row.worktree.path) || "パス未取得"}</span>
                </div>
                <h3 title={branchLabel(row)}>{branchLabel(row)}</h3>
                <code className="worktree-explorer-path" title={row.worktree.path}>{row.worktree.path || "パス未取得"}</code>
                <div className="worktree-explorer-facts">
                  <span><b>HEAD</b> {headLabel(row)}</span>
                  {lane ? <span title={lane.path ?? undefined}><b>作業ブランチ</b> {lane.name}</span> : <span className="is-unknown"><b>作業ブランチ</b> 対応する作業情報なし</span>}
                </div>
              </div>
              <div className="worktree-explorer-card-actions">
                {row.worktree.path.length > 0 && <CopyButton value={row.worktree.path} label="パスをコピー" />}
                {cd && <CopyButton value={cd} label="cd をコピー" />}
                {lane ? <>
                  <button className="worktree-explorer-action" type="button" onClick={() => onSelectLane(lane)}>作業ブランチ詳細</button>
                  <button className="worktree-explorer-action is-primary" type="button" onClick={() => onOpenGit(lane)}>Gitを開く</button>
                </> : <span className="worktree-explorer-no-lane">対応する作業情報なし</span>}
              </div>
            </article>
          );
        })}
        {visible.length === 0 && <div className="worktree-explorer-empty" role="status">
          {summary.total === 0 ? "worktree はありません。" : "条件に一致する worktree はありません。"}
          {(query || stateFilter !== "all" || healthFilter !== "all") && <button type="button" onClick={() => { setQuery(""); setStateFilter("all"); setHealthFilter("all"); }}>絞り込みを解除</button>}
        </div>}
      </div>
    </section>
  );
}

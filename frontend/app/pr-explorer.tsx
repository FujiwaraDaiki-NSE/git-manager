"use client";

import { useMemo, useState } from "react";
import CopyButton from "./copy-button";
import {
  buildPullRequestExplorerData,
  pullRequestsToCsv,
  targetBranchName,
} from "./pr-tools.mjs";
import type { ProjectResponse } from "./types";

type PrRange = "7" | "30" | "all";
type PrSort = "newest" | "oldest" | "number";

const rangeOptions: { id: PrRange; label: string }[] = [
  { id: "7", label: "7日" },
  { id: "30", label: "30日" },
  { id: "all", label: "全期間" },
];

const sortOptions: { id: PrSort; label: string }[] = [
  { id: "newest", label: "新しい順" },
  { id: "oldest", label: "古い順" },
  { id: "number", label: "PR番号順" },
];

function exactDate(value: string | null) {
  if (!value) return "日付未取得";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "日付未取得";
  return date.toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" });
}

function safeHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? value : null;
  } catch {
    return null;
  }
}

function recordNumber(value: number) {
  return `PR #${value}`;
}

function exportFilename(name: string) {
  const safe = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").trim();
  return `${safe || "gitdash"}-merged-prs.csv`;
}

function githubStatusMessage(status: string) {
  switch (status) {
    case "available":
      return null;
    case "unavailable":
      return "GitHubのPR情報を取得できないため、このスナップショットだけではPR履歴の全体を確認できません。認証・接続を確認してください。";
    case "not_applicable":
      return "GitHubのoriginがないため、PR情報はこのプロジェクトの対象外です。";
    default:
      return "GitHubのPR情報の取得状態が未取得です。表示できるPRだけを確認してください。";
  }
}

function PullRequestCard({ record }: { record: {
  number: number;
  url: string;
  source: string;
  target: string;
  commit_hash: string | null;
  merged_at: string | null;
} }) {
  const href = safeHttpUrl(record.url);
  const date = record.merged_at && !Number.isNaN(new Date(record.merged_at).getTime())
    ? new Date(record.merged_at).toISOString()
    : undefined;
  return (
    <li className="pr-explorer-card">
      <div className="pr-explorer-card-rail" aria-hidden="true"><span>#{record.number}</span></div>
      <article className="pr-explorer-card-body">
        <header className="pr-explorer-card-head">
          <div className="pr-explorer-card-title">
            {href ? <a href={href} target="_blank" rel="noreferrer">{recordNumber(record.number)} <span aria-hidden="true">↗</span></a> : <strong>{recordNumber(record.number)}</strong>}
            <span className="pr-explorer-merged-label">マージ済み</span>
          </div>
          <time dateTime={date}>{exactDate(record.merged_at)}</time>
        </header>
        <div className="pr-explorer-route">
        <div className="pr-explorer-endpoint">
            <span className="pr-explorer-endpoint-label">マージ元</span>
            <code title={record.source}>{record.source}</code>
          </div>
          <span className="pr-explorer-route-arrow" aria-label="から">→</span>
          <div className="pr-explorer-endpoint">
            <span className="pr-explorer-endpoint-label">マージ先</span>
            <code title={record.target}>{record.target}</code>
          </div>
        </div>
        <footer className="pr-explorer-card-foot">
          {record.commit_hash ? <><code className="pr-explorer-merge-hash" title={record.commit_hash}>{record.commit_hash}</code><CopyButton value={record.commit_hash} label="マージコミットをコピー" /></> : <span className="pr-explorer-missing-hash">マージコミット未取得</span>}
          {!href && <span className="pr-explorer-missing-url">リンク未取得</span>}
        </footer>
      </article>
    </li>
  );
}

export default function PullRequestExplorer({ project }: { project: ProjectResponse }) {
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState("all");
  const [range, setRange] = useState<PrRange>("all");
  const [sort, setSort] = useState<PrSort>("newest");
  const model = useMemo(() => buildPullRequestExplorerData(project, { query, target, range, sort }), [project, query, range, sort, target]);
  const branchRowsAvailable = project.branch_rows !== null;
  const githubStatus = project.github.status;
  const unavailableMessage = githubStatusMessage(githubStatus);
  const canClaimEmpty = branchRowsAvailable && githubStatus === "available";

  const downloadCsv = () => {
    if (!model.filtered.length) return;
    const blob = new Blob([pullRequestsToCsv(model.filtered)], { type: "text/csv;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = exportFilename(project.name);
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(href), 0);
  };

  return (
    <section className="pr-explorer" aria-labelledby="pr-explorer-title">
      <div className="pr-explorer-heading">
        <div>
          <span className="pr-explorer-eyebrow">MERGED PR HISTORY</span>
          <h4 id="pr-explorer-title">マージ済み PR</h4>
          <p>ブランチの履歴から、重複をまとめて確認できます。</p>
        </div>
        <div className="pr-explorer-total" aria-label="マージ済みPR件数"><strong>{model.all.length}</strong><span>件の記録</span></div>
      </div>

      <div className="pr-explorer-provenance" role="note">
        <span className="pr-explorer-provenance-mark" aria-hidden="true">◈</span>
        <p><strong>表示範囲</strong> 取得済みのブランチに関連するマージ済みPRを表示しています。GitHub上のすべてのPRや、オープンPRを含む一覧ではありません。</p>
      </div>

      {(!branchRowsAvailable || unavailableMessage) && (
        <div className={`pr-explorer-coverage pr-explorer-coverage-${!branchRowsAvailable ? "unknown" : githubStatus}`} role="status">
          <strong>{!branchRowsAvailable ? "ブランチ行のPR履歴を確認できません" : githubStatus === "not_applicable" ? "PR情報は対象外です" : "GitHubのPR履歴を確認できません"}</strong>
          <span>{!branchRowsAvailable ? "ブランチ行の取得に失敗したため、PRがないとは判断できません。再走査してから再試行してください。" : unavailableMessage}</span>
          {project.github.reason && <small>{project.github.reason}</small>}
        </div>
      )}

      <div className="pr-explorer-toolbar" role="search" aria-label="マージ済みPRを絞り込む">
        <label className="pr-explorer-search">
          <span>検索</span>
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="番号・マージ元・マージ先・コミット" aria-label="マージ済みPRを検索" />
        </label>
        <label className="pr-explorer-select">
          <span>マージ先</span>
          <select value={target} onChange={(event) => setTarget(event.target.value)} aria-label="targetブランチで絞り込む">
            <option value="all">すべてのマージ先</option>
            {model.targetOptions.map((value: string) => <option value={value} key={value}>{targetBranchName(value) || value} · {value}</option>)}
          </select>
        </label>
        <label className="pr-explorer-select">
          <span>並び順</span>
          <select value={sort} onChange={(event) => setSort(event.target.value as PrSort)} aria-label="マージ済みPRの並び順">
            {sortOptions.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}
          </select>
        </label>
        <button className="pr-explorer-export" type="button" onClick={downloadCsv} disabled={!model.filtered.length} title={model.filtered.length ? "表示中のPRをCSVで保存" : "保存するPRがありません"}>CSVを保存</button>
      </div>

      <div className="pr-explorer-range-row" role="toolbar" aria-label="マージ日付の範囲">
        <span>マージ日</span>
        <div className="pr-explorer-range-buttons">
          {rangeOptions.map((option) => <button key={option.id} type="button" aria-pressed={range === option.id} onClick={() => setRange(option.id)}>{option.label}</button>)}
        </div>
        <span className="pr-explorer-result-count" role="status">{model.filtered.length} / {model.all.length} 件表示</span>
      </div>

      {range !== "all" && model.dateWindow.state === "unknown" && <p className="pr-explorer-inline-note" role="status">プロジェクトの観測時刻が未取得のため、期間を判定できません。全期間の記録を表示しています。</p>}
      {range !== "all" && model.finiteRangeUnknownDatesExcluded && model.unknownDates > 0 && <p className="pr-explorer-inline-note" role="status">マージ日が未取得の {model.unknownDates} 件は期間を判定できないため除外しています。全期間で確認できます。</p>}

      {!branchRowsAvailable ? null : model.filtered.length ? <ol className="pr-explorer-timeline">{model.filtered.map((record: { number: number; url: string; source: string; target: string; commit_hash: string | null; merged_at: string | null }, index: number) => <PullRequestCard key={`${record.url}:${record.number}:${index}`} record={record} />)}</ol> : githubStatus !== "available" ? (
        <div className="pr-explorer-empty" role="status">
          <strong>確認できるPR記録はありません</strong>
          <span>GitHubまたはブランチ情報が未取得のため、PRがないとは判断できません。</span>
        </div>
      ) : (
        <div className="pr-explorer-empty" role="status">
          {canClaimEmpty && model.all.length === 0 ? <><strong>マージ済みPRはありません</strong><span>取得済みのブランチ行に紐づく記録はありません。</span></> : <><strong>条件に一致するPRはありません</strong><span>検索・マージ先・期間の条件を解除すると、別の記録を確認できます。</span></>}
          {(query || target !== "all" || range !== "all") && <button className="pr-explorer-clear" type="button" onClick={() => { setQuery(""); setTarget("all"); setRange("all"); }}>絞り込みを解除</button>}
        </div>
      )}
    </section>
  );
}

export { PullRequestCard };

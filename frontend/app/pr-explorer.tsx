"use client";

import { useMemo, useState } from "react";
import CopyButton from "./copy-button";
import {
  buildPullRequestExplorerData,
  localCalendarDate,
  pullRequestsToCsv,
  targetBranchName,
  validHttpUrl,
} from "./pr-tools.mjs";
import type { ProjectResponse } from "./types";

type PrRange = "7" | "30" | "all" | "custom";
type PrSort = "newest" | "oldest" | "number";
type PrView = "cards" | "table";
type PullRequestRecord = {
  number: number;
  url: string;
  source: string;
  target: string;
  commit_hash: string | null;
  merged_at: string | null;
};

const rangeOptions: { id: PrRange; label: string }[] = [
  { id: "7", label: "7日" },
  { id: "30", label: "30日" },
  { id: "all", label: "全期間" },
  { id: "custom", label: "指定範囲" },
];

const sortOptions: { id: PrSort; label: string }[] = [
  { id: "newest", label: "新しい順" },
  { id: "oldest", label: "古い順" },
  { id: "number", label: "PR番号順" },
];

function exactDate(value: string | null) {
  if (!value) return "日付未取得";
  if (localCalendarDate(value) === null) return "日付未取得";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "日付未取得";
  return date.toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" });
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

function PullRequestCard({ record }: { record: PullRequestRecord }) {
  const href = validHttpUrl(record.url);
  const date = record.merged_at && localCalendarDate(record.merged_at) !== null && !Number.isNaN(new Date(record.merged_at).getTime())
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

function PullRequestTable({ records }: { records: PullRequestRecord[] }) {
  return (
    <div className="pr-explorer-table-scroll" tabIndex={0} aria-label="マージ済みPRの表。横にスクロールできます">
      <table className="pr-explorer-table">
        <caption className="pr-explorer-visually-hidden">表示中のマージ済みPR</caption>
        <thead>
          <tr><th scope="col">PR</th><th scope="col">マージ日</th><th scope="col">マージ元</th><th scope="col">マージ先</th><th scope="col">マージコミット</th></tr>
        </thead>
        <tbody>
          {records.map((record, index) => {
            const href = validHttpUrl(record.url);
            const date = record.merged_at && localCalendarDate(record.merged_at) !== null && !Number.isNaN(new Date(record.merged_at).getTime())
              ? new Date(record.merged_at).toISOString()
              : undefined;
            return (
              <tr key={`${record.url}:${record.number}:${index}`}>
                <th scope="row">
                  {href ? <a href={href} target="_blank" rel="noreferrer">{recordNumber(record.number)} <span aria-hidden="true">↗</span></a> : <strong>{recordNumber(record.number)}</strong>}
                  <span className="pr-explorer-merged-label">マージ済み</span>
                  {!href && <span className="pr-explorer-table-missing">リンク未取得</span>}
                </th>
                <td><time dateTime={date}>{exactDate(record.merged_at)}</time></td>
                <td><code title={record.source}>{record.source}</code></td>
                <td><code title={record.target}>{record.target}</code></td>
                <td className="pr-explorer-table-hash">
                  {record.commit_hash ? <><code title={record.commit_hash}>{record.commit_hash}</code><CopyButton value={record.commit_hash} label="マージコミットをコピー" /></> : <span className="pr-explorer-missing-hash">マージコミット未取得</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function PullRequestExplorer({ project }: { project: ProjectResponse }) {
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState("all");
  const [source, setSource] = useState("all");
  const [range, setRange] = useState<PrRange>("all");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [sort, setSort] = useState<PrSort>("newest");
  const [view, setView] = useState<PrView>("cards");
  const model = useMemo(() => buildPullRequestExplorerData(project, {
    query,
    target,
    source,
    range,
    startDate: startDate === "" ? null : startDate,
    endDate: endDate === "" ? null : endDate,
    sort,
  }), [project, query, target, source, range, startDate, endDate, sort]);
  const branchRowsAvailable = project.branch_rows !== null;
  const githubStatus = project.github.status;
  const unavailableMessage = githubStatusMessage(githubStatus);
  const canClaimEmpty = branchRowsAvailable && githubStatus === "available";
  const hasActiveFilters = query.trim() !== "" || target !== "all" || source !== "all" || range !== "all" || startDate !== "" || endDate !== "" || sort !== "newest";

  const chooseRange = (nextRange: PrRange) => {
    setRange(nextRange);
    if (nextRange !== "custom") {
      setStartDate("");
      setEndDate("");
    }
  };

  const resetFilters = () => {
    setQuery("");
    setTarget("all");
    setSource("all");
    setRange("all");
    setStartDate("");
    setEndDate("");
    setSort("newest");
  };

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
          <span>マージ元</span>
          <select value={source} onChange={(event) => setSource(event.target.value)} aria-label="sourceブランチで絞り込む">
            <option value="all">すべてのマージ元</option>
            {model.sourceOptions.map((value: string) => <option value={value} title={value} key={value}>{value}</option>)}
          </select>
        </label>
        <label className="pr-explorer-select">
          <span>並び順</span>
          <select value={sort} onChange={(event) => setSort(event.target.value as PrSort)} aria-label="マージ済みPRの並び順">
            {sortOptions.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}
          </select>
        </label>
        <button className="pr-explorer-export" type="button" onClick={downloadCsv} disabled={!model.filtered.length} title={model.filtered.length ? "表示中のPRをCSVで保存" : "保存するPRがありません"}>CSVを保存</button>
        <div className="pr-explorer-copy-urls">
          {model.urlDetails.validCount > 0 ? <CopyButton value={model.urlDetails.value} label={`表示中の${model.urlDetails.validCount}件のPR URLをコピー`} /> : <button className="copy-button" type="button" disabled aria-label="有効なPR URLはありません">PR URLをコピー</button>}
          <span className="pr-explorer-url-summary" role="status">{model.urlDetails.validCount}件をコピー対象{model.urlDetails.invalidCount > 0 && ` · ${model.urlDetails.invalidCount}件は有効なhttp(s) URLではないため除外`}</span>
        </div>
        {hasActiveFilters && <button className="pr-explorer-clear-toolbar" type="button" onClick={resetFilters}>条件をすべて解除</button>}
      </div>

      <div className="pr-explorer-range-row" role="toolbar" aria-label="マージ日付の範囲">
        <span>マージ日</span>
        <div className="pr-explorer-range-buttons">
          {rangeOptions.map((option) => <button key={option.id} type="button" aria-pressed={range === option.id} onClick={() => chooseRange(option.id)}>{option.label}</button>)}
        </div>
        <label className="pr-explorer-date-input"><span>開始日</span><input type="date" value={startDate} onChange={(event) => { setStartDate(event.target.value); setRange("custom"); }} aria-label="マージ日の開始日" /></label>
        <label className="pr-explorer-date-input"><span>終了日</span><input type="date" value={endDate} onChange={(event) => { setEndDate(event.target.value); setRange("custom"); }} aria-label="マージ日の終了日" /></label>
        <span className="pr-explorer-result-count" role="status">{model.filtered.length} / {model.all.length} 件表示</span>
      </div>

      {model.dateWindow.state === "invalid" && <p className="pr-explorer-inline-note pr-explorer-inline-error" role="alert">期間を適用できません。{model.dateWindow.error}</p>}
      {range !== "all" && model.dateWindow.state === "unknown" && <p className="pr-explorer-inline-note" role="status">プロジェクトの観測時刻が未取得のため、期間を判定できません。全期間の記録を表示しています。</p>}
      {model.finiteRangeUnknownDatesExcluded && model.unknownDates > 0 && <p className="pr-explorer-inline-note" role="status">マージ日が未取得の {model.unknownDates} 件は期間を判定できないため除外しています。全期間で確認できます。</p>}

      <div className="pr-explorer-view-row" role="toolbar" aria-label="PRの表示形式">
        <span>表示形式</span>
        <div className="pr-explorer-view-buttons">
          <button type="button" aria-pressed={view === "cards"} onClick={() => setView("cards")}>カード</button>
          <button type="button" aria-pressed={view === "table"} onClick={() => setView("table")}>コンパクト表</button>
        </div>
      </div>

      {!branchRowsAvailable ? null : model.filtered.length ? view === "table" ? <PullRequestTable records={model.filtered} /> : <ol className="pr-explorer-timeline">{model.filtered.map((record: PullRequestRecord, index: number) => <PullRequestCard key={`${record.url}:${record.number}:${index}`} record={record} />)}</ol> : githubStatus !== "available" ? (
        <div className="pr-explorer-empty" role="status">
          <strong>確認できるPR記録はありません</strong>
          <span>GitHubまたはブランチ情報が未取得のため、PRがないとは判断できません。</span>
        </div>
      ) : (
        <div className="pr-explorer-empty" role="status">
          {canClaimEmpty && model.all.length === 0 ? <><strong>マージ済みPRはありません</strong><span>取得済みのブランチ行に紐づく記録はありません。</span></> : <><strong>条件に一致するPRはありません</strong><span>検索・マージ先・期間の条件を解除すると、別の記録を確認できます。</span></>}
        </div>
      )}
    </section>
  );
}

export { PullRequestCard, PullRequestTable };

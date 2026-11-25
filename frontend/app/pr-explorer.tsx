"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import ScrollShadow from "./scroll-shadow";
import CopyButton from "./copy-button";
import { CommitPane } from "./repo-detail";
import {
  buildPullRequestExplorerData,
  filterOpenPullRequests,
  limitedMergedPullRequestCoverage,
  localCalendarDate,
  openPullRequestLocalLanes,
  openPullRequestStatusLabels,
  openPullRequestsNeedingAttention,
  openPullRequestSource,
  pullRequestsToCsv,
  targetBranchName,
  validHttpUrl,
} from "./pr-tools.mjs";
import { updateProjectUrl } from "./project-flow.mjs";
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

function OpenPullRequestAttention({ open, branchRows }: {
  open: ProjectResponse["github"]["open"];
  branchRows: ProjectResponse["branch_rows"];
}) {
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState("");
  const [excludeDraft, setExcludeDraft] = useState(false);
  const searchParams = useSearchParams();
  const pulls = open?.status === "available" ? Array.from(new Map(open.pulls.map((pr) => [pr.number, pr])).values()) : [];
  const targets = [...new Set(pulls.map((pr) => pr.baseRefName))].sort();
  const filtered = filterOpenPullRequests(pulls, { query, target, excludeDraft });
  const result = open?.status === "available" ? {
    pulls,
    matches: openPullRequestsNeedingAttention(pulls),
    checkedAt: open.checked_at === null ? null : new Date(open.checked_at * 1000).toISOString(),
  } : null;
  return (
    <section className="pr-explorer" aria-labelledby="open-pr-attention-title">
      <div className="pr-explorer-heading">
        <h4 id="open-pr-attention-title">対応が必要なオープンPR</h4>
      </div>
      {result === null ? (
        <div className={`pr-explorer-coverage pr-explorer-coverage-${open === undefined ? "unknown" : open.status}`} role="status">
          <strong>{open?.status === "not_applicable" ? "オープンPR情報は対象外です" : open?.status === "unavailable" ? "オープンPRを取得できませんでした" : "オープンPR情報は未取得です"}</strong>
          {open?.reason && <small>{open.reason}</small>}
        </div>
      ) : (
        <>
          <p className="pr-explorer-inline-note" role="status">
            オープンPR {result.pulls.length}件中、CI失敗・変更要求 {result.matches.length}件
            {" · 照会時刻 "}{result.checkedAt === null ? "未取得" : <time dateTime={result.checkedAt}>{exactDate(result.checkedAt)}</time>}
          </p>
          {result.matches.length > 0 && (
            <ul className="pr-explorer-open-list">
              {result.matches.map(({ number, url, reasons }) => {
                const href = validHttpUrl(url);
                const lanes = openPullRequestLocalLanes(branchRows, number);
                return (
                  <li key={number}>
                    {href ? <a href={href} target="_blank" rel="noreferrer">{recordNumber(number)} <span aria-hidden="true">↗</span></a> : <strong>{recordNumber(number)}</strong>}
                    <span>{reasons.join(" · ")}</span>
                    {lanes.map((lane) => (
                      <Link key={lane.id} href={updateProjectUrl(`/project?${searchParams.toString()}`, {
                        tab: "lanes", lane: lane.id, event: null, branchRow: null, relationRef: null,
                      })}><code>{lane.branch ?? lane.name}</code></Link>
                    ))}
                  </li>
                );
              })}
            </ul>
          )}
          <details>
            <summary>すべてのオープンPR（{result.pulls.length}件）</summary>
            {result.pulls.length === 0 ? (
              <p className="pr-explorer-inline-note">オープンPRはありません</p>
            ) : (
              <>
                <div className="pr-explorer-toolbar" role="search" aria-label="オープンPRを絞り込む">
                  <label className="pr-explorer-search">
                    <span>オープンPRを検索</span>
                    <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="番号・題名・作成元" />
                  </label>
                  {query !== "" && <button type="button" className="pr-explorer-clear-toolbar" onClick={() => setQuery("")}>検索を解除</button>}
                  <label className="pr-explorer-select">
                    <span>取り込み先</span>
                    <select value={target} onChange={(event) => setTarget(event.target.value)}>
                      <option value="">すべての取り込み先</option>
                      {target !== "" && !targets.includes(target) && <option value={target}>{target}</option>}
                      {targets.map((name) => <option key={name} value={name}>{name}</option>)}
                    </select>
                  </label>
                  <label><input type="checkbox" checked={excludeDraft} onChange={(event) => setExcludeDraft(event.target.checked)} /> Draftを除く</label>
                </div>
                <p className="pr-explorer-inline-note" role="status">{filtered.length} / {result.pulls.length} 件表示</p>
                {filtered.length === 0 ? <p className="pr-explorer-inline-note">検索条件に一致するオープンPRはありません</p> : <ul className="pr-explorer-open-list pr-explorer-open-all">
                  {filtered.map((pr) => {
                    const href = validHttpUrl(pr.url);
                    const source = openPullRequestSource(pr);
                    const { review, ci } = openPullRequestStatusLabels(pr);
                    return (
                      <li key={pr.number}>
                        <div>
                          {href ? <a href={href} target="_blank" rel="noreferrer">{recordNumber(pr.number)} <span aria-hidden="true">↗</span></a> : <strong>{recordNumber(pr.number)}</strong>}
                          {" "}<strong>{pr.title}</strong>{pr.isDraft && <> <span>Draft</span></>}
                          <div>{source === null ? <>作成元リポジトリ未取得 · <code>{pr.headRefName}</code></> : <code>{source}</code>} → <code>{pr.baseRefName}</code></div>
                        </div>
                        <dl className="pr-explorer-open-status">
                          <div><dt>レビュー</dt><dd>{review}</dd></div>
                          <div><dt>CI</dt><dd>{ci}</dd></div>
                        </dl>
                      </li>
                    );
                  })}
                </ul>}
              </>
            )}
          </details>
        </>
      )}
    </section>
  );
}

type OpenCommit = (hash: string) => void;

function PullRequestCommit({ hash, onOpenCommit }: { hash: string | null; onOpenCommit: OpenCommit }) {
  if (!hash) return <span className="pr-explorer-missing-hash">取り込み先コミット未取得</span>;
  return <>
    <code className="pr-explorer-merge-hash" title={`${hash} · PR取り込み後のコミット。Squash/Rebaseでは複数親のmerge commitとは限りません。`}>{hash}</code>
    <CopyButton value={hash} label="取り込み先コミットをコピー" />
    <button className="subtle-button" type="button" onClick={() => onOpenCommit(hash)}>取り込みコミットを開く</button>
  </>;
}

function PullRequestCard({ record, onOpenCommit }: { record: PullRequestRecord; onOpenCommit: OpenCommit }) {
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
          <PullRequestCommit hash={record.commit_hash} onOpenCommit={onOpenCommit} />
          {!href && <span className="pr-explorer-missing-url">リンク未取得</span>}
        </footer>
      </article>
    </li>
  );
}

function PullRequestTable({ records, onOpenCommit }: { records: PullRequestRecord[]; onOpenCommit: OpenCommit }) {
  return (
    <ScrollShadow className="pr-explorer-table-scroll" label="横スクロールできる表">
      <table className="pr-explorer-table">
        <caption className="pr-explorer-visually-hidden">表示中のマージ済みPR</caption>
        <thead>
          <tr><th scope="col">PR</th><th scope="col">マージ日</th><th scope="col">マージ元</th><th scope="col">マージ先</th><th scope="col" title="PR取り込み後のコミット。Squash/Rebaseでは複数親のmerge commitとは限りません。">取り込み先コミット</th></tr>
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
                  <PullRequestCommit hash={record.commit_hash} onOpenCommit={onOpenCommit} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ScrollShadow>
  );
}

function MergedPullRequestExplorer({ project }: { project: ProjectResponse }) {
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState("all");
  const [source, setSource] = useState("all");
  const [range, setRange] = useState<PrRange>("all");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [sort, setSort] = useState<PrSort>("newest");
  const [view, setView] = useState<PrView>("cards");
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const commitDialog = useRef<HTMLDialogElement>(null);
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
  const limitedCoverage = limitedMergedPullRequestCoverage(project.github);
  const hasActiveFilters = query.trim() !== "" || target !== "all" || source !== "all" || range !== "all" || startDate !== "" || endDate !== "" || sort !== "newest";

  const openCommit: OpenCommit = (hash) => {
    setSelectedHash(hash);
    commitDialog.current?.showModal();
  };

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
      {limitedCoverage !== null && (
        <div className="pr-explorer-coverage" role="status">
          <strong>GitHubのPR履歴は一部取得</strong>
          <span>{limitedCoverage}</span>
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

      {!branchRowsAvailable ? null : model.filtered.length ? (
        view === "table" ? <PullRequestTable records={model.filtered} onOpenCommit={openCommit} /> : (
          <ol className="pr-explorer-timeline">
            {model.filtered.map((record: PullRequestRecord, index: number) => (
              <PullRequestCard key={`${record.url}:${record.number}:${index}`} record={record} onOpenCommit={openCommit} />
            ))}
          </ol>
        )
      ) : githubStatus !== "available" ? (
        <div className="pr-explorer-empty" role="status">
          <strong>確認できるPR記録はありません</strong>
          <span>GitHubまたはブランチ情報が未取得のため、PRがないとは判断できません。</span>
        </div>
      ) : (
        <div className="pr-explorer-empty" role="status">
          {model.all.length === 0 ? <><strong>{limitedCoverage === null ? "マージ済みPRはありません" : "照会範囲内にマージ済みPRの記録はありません"}</strong><span>取得済みのブランチ行に紐づく記録はありません。</span></> : <><strong>条件に一致するPRはありません</strong><span>検索・マージ先・期間の条件を解除すると、別の記録を確認できます。</span></>}
        </div>
      )}
      <dialog
        ref={commitDialog}
        aria-label="取り込みコミット"
        onClose={() => setSelectedHash(null)}
        style={{
          width: "min(960px, calc(100% - 2rem))",
          boxSizing: "border-box",
          background: "var(--pr-panel)",
          color: "var(--pr-ink)",
          border: "1px solid var(--pr-border)",
        }}
      >
        <button className="subtle-button" type="button" onClick={() => commitDialog.current?.close()}>閉じる</button>
        {selectedHash !== null && <CommitPane key={selectedHash} repoPath={project.main_path} hash={selectedHash} onCopy={null} />}
      </dialog>
    </section>
  );
}

export default function PullRequestExplorer({ project }: { project: ProjectResponse }) {
  return (
    <>
      <OpenPullRequestAttention open={project.github.open} branchRows={project.branch_rows} />
      <MergedPullRequestExplorer key={project.main_path} project={project} />
    </>
  );
}

export { PullRequestCard, PullRequestTable };

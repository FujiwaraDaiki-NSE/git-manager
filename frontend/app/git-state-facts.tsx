"use client";

import "./git-state-facts.css";
import CopyButton from "./copy-button";
import type { FetchStatus, GitOperation, BranchDestinations, ProjectSummary } from "./types";

const categories = { authentication: "認証", connection: "接続", timeout: "タイムアウト", other: "その他" };
export function fetchCategoryLabel(category: FetchStatus["category"]) {
  return category === null ? "未取得" : categories[category];
}

export function FetchFailureBreakdown({ projects }: { projects: Pick<ProjectSummary, "fetch_status">[] }) {
  const counts = new Map<FetchStatus["category"], number>();
  for (const { fetch_status: status } of projects) {
    if (status?.result !== "failure") continue;
    counts.set(status.category, (counts.get(status.category) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return <p className="toolbar-note" role="status">fetch失敗の内訳　{Array.from(counts, ([category, count]) => `${fetchCategoryLabel(category)} ${count}件`).join(" · ")}</p>;
}

export function FetchFacts({ fetchedAt, status }: { fetchedAt: number | null | undefined; status: FetchStatus | null | undefined }) {
  return <div className="git-state-facts"><div>最後に成功したfetch: {fetchedAt == null ? "記録なし" : new Date(fetchedAt * 1000).toLocaleString("ja-JP")}</div><div>直近の試行: {status == null ? "記録なし" : `${status.result === "success" ? "成功" : "失敗"}（${new Date(status.attempted_at * 1000).toLocaleString("ja-JP")}）`}</div>{status?.result === "failure" && <div role="status">失敗理由: {fetchCategoryLabel(status.category)} · {status.reason === null ? "stderr未取得" : status.reason === "" ? "stderrなし" : status.reason}</div>}</div>;
}
function Command({ command, reason }: { command: string; reason: string }) {
  return <div className="selection-command"><code>{command}</code><CopyButton value={command} label="コマンドをコピー" /><small>{reason}</small></div>;
}
export function OperationFacts({ operations }: { operations: GitOperation[] | null | undefined }) {
  return <section className="git-state-facts" aria-label="Git操作の途中状態"><strong>Git操作の途中状態</strong>{operations == null ? <p>未取得</p> : operations.length === 0 ? <p>進行中の操作なし</p> : operations.map((operation) => <div key={operation.marker}><p><strong>{operation.kind}途中{operation.step !== null && operation.total !== null ? `（${operation.step}/${operation.total}）` : ""}</strong> · {operation.marker}</p>{operation.commands.map((command) => <Command key={command.command} {...command} />)}</div>)}</section>;
}
export function DestinationFacts({ destinations: d }: { destinations: BranchDestinations | null | undefined }) {
  const value = (v: string | null) => v === null ? "未設定" : v;
  return <section className="git-state-facts" aria-label="fetch先・追跡先・push先"><strong>fetch先・追跡先・push先</strong>{d == null ? <p>未取得</p> : <dl className="selection-list"><div><dt>fetch元remote</dt><dd>{value(d.fetch_remote)}</dd></div><div><dt>fetch URL</dt><dd>{d.fetch_urls === null ? d.fetch_remote === null ? "設定なし" : "取得不能" : d.fetch_urls.join(" / ")}</dd></div><div><dt>upstream（追跡先）</dt><dd>{d.upstream_state === "unset" ? "未設定" : d.upstream === null ? "追跡参照なし" : d.upstream}{d.upstream_ref && <small>{d.upstream_ref}</small>}</dd></div><div><dt>実効push remote</dt><dd>{value(d.push_remote)}</dd></div><div><dt>push URL（全送信先）</dt><dd>{d.push_urls === null ? d.push_remote === null ? "設定なし" : "取得不能" : d.push_urls.join(" / ")}</dd></div><div><dt>push先ref</dt><dd>{d.push_ref === null ? d.push_ref_reason : d.push_ref}</dd></div><div><dt>remote.push refspec</dt><dd>{d.push_refspecs === null ? "未取得" : d.push_refspecs.length === 0 ? "設定なし" : d.push_refspecs.join(" / ")}</dd></div><div><dt>push.default</dt><dd>{value(d.push_default)}</dd></div></dl>}</section>;
}

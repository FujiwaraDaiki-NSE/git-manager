"use client";

import "./git-state-facts.css";
import CopyButton from "./copy-button";
import { worktreeCommand } from "./next-command-tools.mjs";
import type { FetchStatus, GitOperation, BranchDestinations, ProjectSummary, PushRemoteConfig } from "./types";

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
function Command({ command, reason, path }: { command: string; reason: string; path: string | null }) {
  const scopedCommand = path === null ? null : worktreeCommand(command, path, null);
  return <div className="selection-command">
    {scopedCommand !== null && <><code>{scopedCommand}</code><CopyButton value={scopedCommand} label="コマンドをコピー" /></>}
    <small>実行先: {path === null ? "未取得" : path}</small>
    <small>{reason}</small>
  </div>;
}
export function OperationFacts({ operations, path }: { operations: GitOperation[] | null | undefined; path: string | null }) {
  return <section className="git-state-facts" aria-label="Git操作の途中状態">
    <strong>Git操作の途中状態</strong>
    {operations == null ? <p>未取得</p> : operations.length === 0 ? <p>進行中の操作なし</p> : operations.map(({ kind, marker, step, total, commands }) => (
      <div key={marker}>
        <p><strong>{kind}途中{step !== null && total !== null ? `（${step}/${total}）` : ""}</strong> · {marker}</p>
        {(kind === "rebase" || kind === "am") && step !== null && total !== null
          && Number.isInteger(step) && Number.isInteger(total) && step >= 1 && step <= total && (
          <div className="git-operation-progress">
            <span>全{total}件のうち{step}件目を処理中</span>
            <div className="git-operation-progress-track" aria-hidden="true">
              <span className="git-operation-progress-earlier" style={{ flexGrow: step - 1 }} />
              <span className="git-operation-progress-current" />
              <span style={{ flexGrow: total - step }} />
            </div>
          </div>
        )}
        {commands.map((command) => <Command key={command.command} {...command} path={path} />)}
      </div>
    ))}
  </section>;
}
function PushRemoteDetails({ config, remote }: { config: PushRemoteConfig; remote: string | null }) {
  return (
    <details>
      <summary>push先の設定を調べる</summary>
      <p>設定元とスコープは gitdash の実行環境で観測したものです。</p>
      {config.selected_key === null && <p>{remote === null ? "push先は未設定です。" : "Git の既定動作で決まりました。"}</p>}
      <dl className="selection-list">
        {config.keys.map(({ key, values, command }) => (
          <div key={key}>
            <dt><code>{key}</code></dt>
            <dd>
              {values.length === 0 ? <small>未設定</small> : values.map(({ value, scope, origin }, index) => (
                <p key={index}>
                  <code>{value === null ? "値の指定なし" : value === "" ? "空文字列" : value}</code>
                  {key === config.selected_key && index === values.length - 1 && <strong> 採用</strong>}
                  <small>{scope} · <code>{origin}</code></small>
                </p>
              ))}
              <p className="selection-command">
                <code>{command}</code>
                <CopyButton value={command} label={`${key} の確認コマンドをコピー`} />
              </p>
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
export function DestinationFacts({ destinations: d }: { destinations: BranchDestinations | null | undefined }) {
  const value = (v: string | null) => v === null ? "未設定" : v;
  return <section className="git-state-facts" aria-label="fetch先・追跡先・push先"><strong>fetch先・追跡先・push先</strong>{d == null ? <p>未取得</p> : <><dl className="selection-list"><div><dt>fetch元remote</dt><dd>{value(d.fetch_remote)}</dd></div><div><dt>fetch URL</dt><dd>{d.fetch_urls === null ? d.fetch_remote === null ? "設定なし" : "取得不能" : d.fetch_urls.join(" / ")}</dd></div><div><dt>upstream（追跡先）</dt><dd>{d.upstream_state === "unset" ? "未設定" : d.upstream === null ? "追跡参照なし" : d.upstream}{d.upstream_ref && <small>{d.upstream_ref}</small>}</dd></div><div><dt>実効push remote</dt><dd>{value(d.push_remote)}</dd></div><div><dt>push URL（全送信先）</dt><dd>{d.push_urls === null ? d.push_remote === null ? "設定なし" : "取得不能" : d.push_urls.join(" / ")}</dd></div><div><dt>push先ref</dt><dd>{d.push_ref === null ? d.push_ref_reason : d.push_ref}</dd></div><div><dt>remote.push refspec</dt><dd>{d.push_refspecs === null ? "未取得" : d.push_refspecs.length === 0 ? "設定なし" : d.push_refspecs.join(" / ")}</dd></div><div><dt>push.default</dt><dd>{value(d.push_default)}</dd></div></dl><PushRemoteDetails config={d.push_remote_config} remote={d.push_remote} /></>}</section>;
}

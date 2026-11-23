"use client";
import { useEffect, useId, useRef, useState } from "react";
import { agentStateLabel, agentTaskState } from "./agent-overview.mjs";
import { fileStatusDescription } from "./file-status.mjs";
import CopyButton from "./copy-button";
import CommitFiles from "./commit-files";
import PatchView from "./patch-view";
import type { AgentTask, CommitDetail } from "./types";
import "./tag-explorer.css";
import "./repository-investigations.css";

const patchLabels = { "<": "Aのみ", ">": "Bのみ", "=": "同等" } as const;
type PatchMark = keyof typeof patchLabels;
const patchMarks: PatchMark[] = ["<", ">", "="];
type Commit = { hash: string; subject: string; date: string; author: string; committer_date?: string; mark?: PatchMark; is_tip?: boolean; sources?: { selector: string; message: string }[]; command?: string };
type Result = { commits?: Commit[]; scope?: string; fixed_shas?: string[]; offset?: number; has_more?: boolean; left?: string; right?: string; left_sha?: string; right_sha?: string; command?: string | null; complete?: boolean; unavailable?: string[]; overlaps?: { path: string; worktrees: { worktree: string; branch: string | null; xy: string[] }[] }[] };
async function read<T,>(url: string, signal: AbortSignal, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store", signal });
  if (!response.ok) {
    const body = await response.json();
    throw new Error(typeof body.detail === "string" ? body.detail : `取得失敗 HTTP ${response.status}`);
  }
  return response.json();
}
function Detail({ path, hash }: { path: string; hash: string }) {
  const [data, setData] = useState<CommitDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void read<CommitDetail>(`/api/repo/commit?${new URLSearchParams({ path, hash })}`, controller.signal).then(setData).catch(e => { if (!controller.signal.aborted) setError(String(e)); });
    return () => controller.abort();
  }, [path, hash]);
  return <section className="tag-explorer-detail"><div className="tag-explorer-detail-heading"><h3>コミット詳細</h3><code>{hash}</code></div>{error && <p className="tag-explorer-error" role="alert">{error}</p>}{!data && !error && <p className="tag-explorer-state" role="status">取得中…</p>}{data && <><p className="tag-explorer-note">{data.subject}</p><CommitFiles files={data.files} downloadName={`${hash}.tsv`} /><PatchView patch={data.patch} />{data.patch_truncated && <p className="tag-explorer-note">パッチは一部省略されています。</p>}</>}</section>;
}
type InvestigationProps = { path: string } & (
  | { kind: "overlaps"; agentTasks: AgentTask[] | null; onOpenWorktree: (path: string) => void }
  | { kind: "search" | "recovery" | "cherry" }
);
function searchDateBounds(since: string, until: string) {
  const sinceAt = since === "" ? "" : new Date(`${since}T00:00:00`).toISOString();
  if (until === "") return { since_at: sinceAt, until_at: "" };
  // Advance the calendar date before interpreting midnight in the browser's timezone.
  const nextDate = new Date(`${until}T00:00:00Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const nextMidnight = new Date(`${nextDate.toISOString().split("T")[0]}T00:00:00`);
  return { since_at: sinceAt, until_at: new Date(nextMidnight.getTime() - 1000).toISOString() };
}
const settings = {
  overlaps: ["worktree間の変更パス重なり", "worktree-overlaps", "同じパスを変更中でも、競合するとは限りません。各worktreeを順に観測した結果です。"],
  search: ["リポジトリ全体のコミット検索", "commit-search", "件名・本文と作成者はGitの正規表現、変更パスはGitのpathspecで検索します。変更内容では、文字列の出現数がファイル内で変わったコミットを検索します。検索対象の参照SHAはページ間で固定します。"],
  recovery: ["到達不能コミットの復旧候補", "recovery-candidates", "現在のref・HEADから到達できない、reflogに残る履歴を表示します。reflog保存期間外は検出できません。復旧コマンドは対象リポジトリで実行してください。"],
  cherry: ["パッチ同等コミットの判定", "patch-equivalence", "パッチ同等＝安全な重複とは限りません。= はパッチ同等、< はAのみ、> はBのみです。共通コミットは表示しません。"],
};
function Investigation(props: InvestigationProps) {
  const { path, kind } = props;
  const inputId = useId();
  const [fields, setFields] = useState<Record<string, string>>({ scope: "--all", mode: "message", grep: "", author: "", since: "", until: "", file: "", left: "", right: "" });
  const [data, setData] = useState<Result | null>(null);
  const [request, setRequest] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [pageLoading, setPageLoading] = useState<string | null>(null);
  const [overlapWorktree, setOverlapWorktree] = useState("");
  const [tipsOnly, setTipsOnly] = useState(false);
  const overlapWorktrees = data?.overlaps && [...new Set(data.overlaps.flatMap(item => item.worktrees.map(w => w.worktree)))].sort();
  const overlaps = data?.overlaps?.filter(item => overlapWorktree === "" || item.worktrees.some(w => w.worktree === overlapWorktree));
  const commits = tipsOnly ? data?.commits?.filter(c => c.is_tip === true) : data?.commits;
  const invalidDates = kind === "search" && fields.since !== "" && fields.until !== "" && fields.since > fields.until;
  const dateErrorId = `${inputId}-date-error`;
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const [title, endpoint, note] = settings[kind];
  const inputs = kind === "search" ? [["scope", "検索範囲（--all または ref）"], ["mode", "検索対象"], ["grep", "検索文字列"], ["author", "作成者"], ["since", "開始日"], ["until", "終了日"], ["file", "変更パス"]] : kind === "cherry" ? [["left", "A ブランチ / ref"], ["right", "B ブランチ / ref"]] : [];
  async function run(values: Record<string, string>, offset: number, fixedShas: string[] | null = null) {
    if (kind === "search" && values.since !== "" && values.until !== "" && values.since > values.until) return;
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    setLoading(true);
    setPageLoading(fixedShas === null ? null : offset > data!.offset! ? "次の50件を取得中…" : "前の50件を取得中…");
    if (fixedShas === null) setData(null);
    setOverlapWorktree("");
    setError(null); setSelected(null);
    try {
      const submitted = kind === "search" && fixedShas === null
        ? { ...values, ...searchDateBounds(values.since, values.until) }
        : values;
      setRequest(submitted);
      const params: Record<string, string> = { path };
      for (const [key] of inputs) {
        if (key !== "since" && key !== "until") params[key] = submitted[key];
      }
      if (kind === "search") {
        params.offset = String(offset);
        params.since_at = submitted.since_at;
        params.until_at = submitted.until_at;
      }
      const url = fixedShas === null ? `/api/repo/${endpoint}?${new URLSearchParams(params)}` : `/api/repo/${endpoint}`;
      const init: RequestInit | undefined = fixedShas === null ? undefined : {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...params, offset, fixed_shas: fixedShas }),
      };
      const result = await read<Result>(url, current.signal, init);
      if (!current.signal.aborted) setData(result);
    } catch (e) { if (!current.signal.aborted) setError(String(e)); }
    finally { if (!current.signal.aborted) { setLoading(false); setPageLoading(null); } }
  }
  return (
    <details className="tag-explorer repository-investigation">
      <summary>{title}</summary>
      <div className="tag-explorer-body">
        <p className="tag-explorer-note">{note}</p>
        <form className="tag-explorer-tools" onSubmit={e => { e.preventDefault(); void run({ ...fields }, 0); }}>
          {inputs.map(([key, label]) => (
            <label key={key} htmlFor={`${inputId}-${key}`}>
              <span>{label}</span>
              {key === "mode" ? <select id={`${inputId}-${key}`} value={fields.mode} onChange={e => setFields({ ...fields, mode: e.target.value })}>
                <option value="message">件名・本文</option>
                <option value="content">変更内容の文字列（git log -S）</option>
              </select> : <input id={`${inputId}-${key}`} type={key === "since" || key === "until" ? "date" : "text"} required={key === "scope" || key === "left" || key === "right"} value={fields[key]} aria-invalid={(key === "since" || key === "until") && invalidDates ? true : undefined} aria-describedby={(key === "since" || key === "until") && invalidDates ? dateErrorId : undefined} onChange={e => setFields({ ...fields, [key]: e.target.value })} />}
            </label>
          ))}
          {invalidDates && <p id={dateErrorId} className="tag-explorer-error repository-investigation-date-error" role="alert">開始日は終了日以前の日付にしてください</p>}
          <button className="tag-explorer-export" disabled={loading} type="submit">{loading ? "取得中…" : "調査する"}</button>
        </form>
        {error && <p className="tag-explorer-error" role="alert">取得できませんでした。{error}</p>}
        {data && <div aria-live="polite" aria-busy={loading}>
          {pageLoading && <p className="tag-explorer-state" role="status">{pageLoading}</p>}
          {kind === "search" && request && <p className="tag-explorer-note">適用した条件: {request.mode === "content" ? "変更内容の文字列" : "件名・本文"}「{request.grep}」、作成者「{request.author}」、期間「{request.since} ～ {request.until}」、変更パス「{request.file}」（空欄は条件なし）</p>}
          {kind === "search" && request && <p className="tag-explorer-note">検索開始時点の参照で固定中 <button className="tag-explorer-export" type="button" disabled={loading} onClick={() => void run(request, 0)}>最新状態で検索し直す</button></p>}
          {data.scope && <p className="tag-explorer-note">検索範囲: <code>{data.scope}</code></p>}
          {kind === "search" && data.commits && data.commits.length > 0 && <p className="tag-explorer-note">{data.offset! + 1}〜{data.offset! + data.commits.length}件目を表示</p>}
          {data.left && <p className="tag-explorer-note">A: {data.left} @ {data.left_sha?.slice(0, 12)} ／ B: {data.right} @ {data.right_sha?.slice(0, 12)}</p>}
          {data.command && <p className="tag-explorer-note">{kind === "search" && "再現用コマンド（対象リポジトリで実行） "}<code>{data.command}</code>{kind === "search" && <> <CopyButton value={data.command} label="再現用コマンドをコピー" /></>}</p>}
          {data.unavailable && data.unavailable.length > 0 && <p className="tag-explorer-error" role="alert">一部worktreeを取得できませんでした。重なりの一覧は不完全です: {data.unavailable.join("、")}</p>}
          {kind === "overlaps" && overlapWorktrees && overlapWorktrees.length > 0 && <div className="tag-explorer-tools">
            <label>
              <span>対象worktree</span>
              <select value={overlapWorktree} onChange={e => setOverlapWorktree(e.target.value)}>
                <option value="">すべてのworktree</option>
                {overlapWorktrees.map(worktree => <option key={worktree} value={worktree}>{worktree}</option>)}
              </select>
            </label>
          </div>}
          {kind === "overlaps" && overlaps && (overlaps.length ? (
            <ul className="repository-investigation-list">
              {overlaps.map(item => <li className="tag-explorer-commit" key={item.path}>
                <div className="tag-explorer-commit-heading"><strong><code>{item.path}</code></strong></div>
                <ul className="repository-investigation-list">
                  {item.worktrees.map(w => {
                    const branch = w.branch === null ? null : w.branch.replace(/^refs\/heads\//, "");
                    const task = branch === null ? undefined : props.agentTasks?.find(task => task.branch === branch && agentTaskState(task) !== null);
                    return <li className="tag-explorer-commit-meta" key={w.worktree}>
                      <span>{w.worktree}</span>
                      <span>{branch === null ? "detached HEAD（ブランチなし）" : branch}</span>
                      {w.xy.map((xy) => <span key={xy}><code className="repository-investigation-xy">{xy}</code> {fileStatusDescription(xy)}</span>)}
                      {task && <div className="repository-investigation-agent-report">
                        <strong>ブランチのagent報告</strong> <span>{agentStateLabel(agentTaskState(task))}</span>
                        {task.summary !== null && <div>{task.summary}</div>}
                        {task.decision && <div>質問 {task.decision.question}</div>}
                        {task.occurred_at !== null && <div>報告時刻 <time dateTime={task.occurred_at}>{new Date(task.occurred_at).toLocaleString("ja-JP")}</time></div>}
                      </div>}
                      <button className="tag-explorer-export" type="button" onClick={() => props.onOpenWorktree(w.worktree)}>このworktreeの状態を開く</button>
                    </li>;
                  })}
                </ul>
              </li>)}
            </ul>
          ) : <p className="tag-explorer-empty">{data.complete ? "変更パスの重なりはありません。" : "取得できたworktree間では変更パスの重なりはありません。"}</p>)}
          {kind === "recovery" && data.commits && data.commits.length > 0 && <label className="repository-investigation-tips">
            <input type="checkbox" checked={tipsOnly} onChange={e => {
              const checked = e.target.checked;
              setTipsOnly(checked);
              if (checked && data.commits?.some(c => c.hash === selected && c.is_tip === false)) setSelected(null);
            }} />
            先端候補のみ
          </label>}
          {kind === "cherry" && commits && <p className="repository-investigation-patch-counts" aria-label="判定別のコミット件数">
            {patchMarks.map(mark => <span key={mark}>{patchLabels[mark]} {commits.filter(c => c.mark === mark).length}件</span>)}
          </p>}
          {commits && (commits.length ? (
            <ul className="repository-investigation-list">
              {commits.map(c => <li className="tag-explorer-commit" key={c.hash}>
                <button className="tag-explorer-select" type="button" aria-pressed={selected === c.hash} onClick={() => setSelected(c.hash)}>
                  <strong>{c.subject}</strong>
                  <code>{c.mark === undefined ? c.hash : `${c.mark} ${c.hash}`}</code>
                </button>
                <p className="tag-explorer-commit-meta">
                  {c.mark !== undefined && <span className="repository-investigation-patch-mark">{patchLabels[c.mark]}</span>}
                  {c.committer_date !== undefined && <span>期間判定に使うコミッター日時 <time dateTime={c.committer_date}>{new Date(c.committer_date).toLocaleString("ja-JP", { timeZoneName: "short" })}</time></span>}
                  <span>{kind === "search" && "作者日時 "}<time dateTime={c.date}>{c.date}</time></span>
                  <span>{c.author}</span>
                </p>
                {c.sources && <>
                  {c.sources.length === 0 && <p className="tag-explorer-note">この祖先コミットを直接指すreflog操作はありません。</p>}
                  <ul className="repository-investigation-list">
                    {c.sources.map((source, i) => <li className="tag-explorer-commit-meta" key={i}><code>{source.selector}</code><span>{source.message}</span></li>)}
                  </ul>
                </>}
                {c.command && <div className="tag-explorer-commit-meta"><code>{c.command}</code><CopyButton value={c.command} label="復旧コマンドをコピー" /></div>}
              </li>)}
            </ul>
          ) : <p className="tag-explorer-empty">{kind === "search" ? data.offset === 0 ? "検索結果0件" : "このページに該当するコミットはありません" : "該当するコミットはありません。"}</p>)}
          {kind === "search" && request && <div className="tag-explorer-navigation">
            <button className="tag-explorer-export" type="button" disabled={loading || data.offset === 0} onClick={() => void run(request, data.offset! - 50, data.fixed_shas!)}>前の50件</button>
            <button className="tag-explorer-export" type="button" disabled={loading || !data.has_more} onClick={() => void run(request, data.offset! + 50, data.fixed_shas!)}>次の50件</button>
          </div>}
        </div>}
        {selected && <>
          <div className="tag-explorer-navigation"><button className="tag-explorer-export" type="button" onClick={() => setSelected(null)}>コミット詳細を閉じる</button></div>
          <Detail key={selected} path={path} hash={selected} />
        </>}
      </div>
    </details>
  );
}
export function WorktreeOverlaps({ path, agentTasks, onOpenWorktree }: Omit<Extract<InvestigationProps, { kind: "overlaps" }>, "kind">) { return <Investigation key={path} path={path} kind="overlaps" agentTasks={agentTasks} onOpenWorktree={onOpenWorktree} />; }
export function CommitSearch({ path }: { path: string }) { return <Investigation key={path} path={path} kind="search" />; }
export function RecoveryCandidates({ path }: { path: string }) { return <Investigation key={path} path={path} kind="recovery" />; }
export function PatchEquivalence({ path }: { path: string }) { return <Investigation key={path} path={path} kind="cherry" />; }

"use client";
import { useEffect, useId, useRef, useState } from "react";
import { fileStatusDescription } from "./file-status.mjs";
import CopyButton from "./copy-button";
import CommitFiles from "./commit-files";
import PatchView from "./patch-view";
import type { CommitDetail } from "./types";
import "./tag-explorer.css";
import "./repository-investigations.css";

type Commit = { hash: string; subject: string; date: string; author: string; mark?: string; sources?: { selector: string; message: string }[]; command?: string };
type Result = { commits?: Commit[]; scope?: string; fixed_shas?: string[]; offset?: number; has_more?: boolean; left?: string; right?: string; left_sha?: string; right_sha?: string; command?: string; complete?: boolean; unavailable?: string[]; overlaps?: { path: string; worktrees: { worktree: string; branch: string | null; xy: string[] }[] }[] };
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
  | { kind: "overlaps"; onOpenWorktree: (path: string) => void }
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
  search: ["リポジトリ全体のコミット検索", "commit-search", "件名・本文と作成者はGitの正規表現、変更パスはGitのpathspecで検索します。検索対象の参照SHAはページ間で固定します。"],
  recovery: ["到達不能コミットの復旧候補", "recovery-candidates", "現在のref・HEADから到達できない、reflogに残る履歴を表示します。reflog保存期間外は検出できません。復旧コマンドは対象リポジトリで実行してください。"],
  cherry: ["パッチ同等コミットの判定", "patch-equivalence", "パッチ同等＝安全な重複とは限りません。= はパッチ同等、< はAのみ、> はBのみです。共通コミットは表示しません。"],
};
function Investigation(props: InvestigationProps) {
  const { path, kind } = props;
  const inputId = useId();
  const [fields, setFields] = useState<Record<string, string>>({ scope: "--all", grep: "", author: "", since: "", until: "", file: "", left: "", right: "" });
  const [data, setData] = useState<Result | null>(null);
  const [request, setRequest] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [pageLoading, setPageLoading] = useState<string | null>(null);
  const invalidDates = kind === "search" && fields.since !== "" && fields.until !== "" && fields.since > fields.until;
  const dateErrorId = `${inputId}-date-error`;
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const [title, endpoint, note] = settings[kind];
  const inputs = kind === "search" ? [["scope", "検索範囲（--all または ref）"], ["grep", "件名・本文"], ["author", "作成者"], ["since", "開始日"], ["until", "終了日"], ["file", "変更パス"]] : kind === "cherry" ? [["left", "A ブランチ / ref"], ["right", "B ブランチ / ref"]] : [];
  async function run(values: Record<string, string>, offset: number, fixedShas: string[] | null = null) {
    if (kind === "search" && values.since !== "" && values.until !== "" && values.since > values.until) return;
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    setLoading(true);
    setPageLoading(fixedShas === null ? null : offset > data!.offset! ? "次の50件を取得中…" : "前の50件を取得中…");
    if (fixedShas === null) setData(null);
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
              <input id={`${inputId}-${key}`} type={key === "since" || key === "until" ? "date" : "text"} required={key === "scope" || key === "left" || key === "right"} value={fields[key]} aria-invalid={(key === "since" || key === "until") && invalidDates ? true : undefined} aria-describedby={(key === "since" || key === "until") && invalidDates ? dateErrorId : undefined} onChange={e => setFields({ ...fields, [key]: e.target.value })} />
            </label>
          ))}
          {invalidDates && <p id={dateErrorId} className="tag-explorer-error repository-investigation-date-error" role="alert">開始日は終了日以前の日付にしてください</p>}
          <button className="tag-explorer-export" disabled={loading} type="submit">{loading ? "取得中…" : "調査する"}</button>
        </form>
        {error && <p className="tag-explorer-error" role="alert">取得できませんでした。{error}</p>}
        {data && <div aria-live="polite" aria-busy={loading}>
          {pageLoading && <p className="tag-explorer-state" role="status">{pageLoading}</p>}
          {kind === "search" && request && <p className="tag-explorer-note">適用した条件: 件名・本文「{request.grep}」、作成者「{request.author}」、期間「{request.since} ～ {request.until}」、変更パス「{request.file}」（空欄は条件なし）</p>}
          {kind === "search" && request && <p className="tag-explorer-note">検索開始時点の参照で固定中 <button className="tag-explorer-export" type="button" disabled={loading} onClick={() => void run(request, 0)}>最新状態で検索し直す</button></p>}
          {data.scope && <p className="tag-explorer-note">検索範囲: <code>{data.scope}</code></p>}
          {kind === "search" && data.commits && data.commits.length > 0 && <p className="tag-explorer-note">{data.offset! + 1}〜{data.offset! + data.commits.length}件目を表示</p>}
          {data.left && <p className="tag-explorer-note">A: {data.left} @ {data.left_sha?.slice(0, 12)} ／ B: {data.right} @ {data.right_sha?.slice(0, 12)}</p>}
          {data.command && <p className="tag-explorer-note"><code>{data.command}</code></p>}
          {data.unavailable && data.unavailable.length > 0 && <p className="tag-explorer-error" role="alert">一部worktreeを取得できませんでした。重なりの一覧は不完全です: {data.unavailable.join("、")}</p>}
          {kind === "overlaps" && data.overlaps && (data.overlaps.length ? (
            <ul className="repository-investigation-list">
              {data.overlaps.map(item => <li className="tag-explorer-commit" key={item.path}>
                <div className="tag-explorer-commit-heading"><strong><code>{item.path}</code></strong></div>
                <ul className="repository-investigation-list">
                  {item.worktrees.map(w => <li className="tag-explorer-commit-meta" key={w.worktree}>
                    <span>{w.worktree}</span>
                    <span>{w.branch === null ? "detached HEAD（ブランチなし）" : w.branch.replace(/^refs\/heads\//, "")}</span>
                    {w.xy.map((xy) => <span key={xy}><code className="repository-investigation-xy">{xy}</code> {fileStatusDescription(xy)}</span>)}
                    <button className="tag-explorer-export" type="button" onClick={() => props.onOpenWorktree(w.worktree)}>このworktreeの状態を開く</button>
                  </li>)}
                </ul>
              </li>)}
            </ul>
          ) : <p className="tag-explorer-empty">{data.complete ? "変更パスの重なりはありません。" : "取得できたworktree間では変更パスの重なりはありません。"}</p>)}
          {data.commits && (data.commits.length ? (
            <ul className="repository-investigation-list">
              {data.commits.map(c => <li className="tag-explorer-commit" key={c.hash}>
                <button className="tag-explorer-select" type="button" aria-pressed={selected === c.hash} onClick={() => setSelected(c.hash)}>
                  <strong>{c.subject}</strong>
                  <code>{c.mark} {c.hash}</code>
                </button>
                <p className="tag-explorer-commit-meta"><time dateTime={c.date}>{c.date}</time><span>{c.author}</span></p>
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
export function WorktreeOverlaps({ path, onOpenWorktree }: { path: string; onOpenWorktree: (path: string) => void }) { return <Investigation key={path} path={path} kind="overlaps" onOpenWorktree={onOpenWorktree} />; }
export function CommitSearch({ path }: { path: string }) { return <Investigation key={path} path={path} kind="search" />; }
export function RecoveryCandidates({ path }: { path: string }) { return <Investigation key={path} path={path} kind="recovery" />; }
export function PatchEquivalence({ path }: { path: string }) { return <Investigation key={path} path={path} kind="cherry" />; }

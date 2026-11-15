"use client";
import { useEffect, useId, useRef, useState } from "react";
import CopyButton from "./copy-button";
import CommitFiles from "./commit-files";
import PatchView from "./patch-view";
import type { CommitDetail } from "./types";
import "./tag-explorer.css";
import "./repository-investigations.css";

type Commit = { hash: string; subject: string; date: string; author: string; mark?: string; sources?: { selector: string; message: string }[]; command?: string };
type Result = { commits?: Commit[]; scope?: string; offset?: number; has_more?: boolean; left?: string; right?: string; command?: string; complete?: boolean; unavailable?: string[]; overlaps?: { path: string; worktrees: { worktree: string; branch: string | null; xy: string }[] }[] };
async function read<T,>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal });
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
type Kind = "overlaps" | "search" | "recovery" | "cherry";
const settings = {
  overlaps: ["worktree間の変更パス重なり", "worktree-overlaps", "同じパスを変更中でも、競合するとは限りません。各worktreeを順に観測した結果です。"],
  search: ["リポジトリ全体のコミット検索", "commit-search", "件名・本文と作成者はGitの正規表現、変更パスはGitのpathspecで検索します。参照SHAはページ間で固定しません。"],
  recovery: ["到達不能コミットの復旧候補", "recovery-candidates", "現在のref・HEADから到達できない、reflogに残る履歴を表示します。reflog保存期間外は検出できません。復旧コマンドは対象リポジトリで実行してください。"],
  cherry: ["パッチ同等コミットの判定", "patch-equivalence", "パッチ同等＝安全な重複とは限りません。= はパッチ同等、< はAのみ、> はBのみです。共通コミットは表示しません。"],
};
function Investigation({ path, kind }: { path: string; kind: Kind }) {
  const inputId = useId();
  const [fields, setFields] = useState<Record<string, string>>({ scope: "--all", grep: "", author: "", since: "", until: "", file: "", left: "", right: "" });
  const [data, setData] = useState<Result | null>(null);
  const [request, setRequest] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const [title, endpoint, note] = settings[kind];
  const inputs = kind === "search" ? [["scope", "検索範囲（--all または ref）"], ["grep", "件名・本文"], ["author", "作成者"], ["since", "開始日"], ["until", "終了日"], ["file", "変更パス"]] : kind === "cherry" ? [["left", "A ブランチ / ref"], ["right", "B ブランチ / ref"]] : [];
  async function run(values: Record<string, string>, offset: number) {
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    setLoading(true); setData(null); setError(null); setSelected(null);
    setRequest(values);
    const params: Record<string, string> = { path };
    for (const [key] of inputs) params[key] = values[key];
    if (kind === "search") { params.offset = String(offset); params.tz_offset = String(-new Date().getTimezoneOffset()); }
    try { const result = await read<Result>(`/api/repo/${endpoint}?${new URLSearchParams(params)}`, current.signal); if (!current.signal.aborted) setData(result); }
    catch (e) { if (!current.signal.aborted) setError(String(e)); }
    finally { if (!current.signal.aborted) setLoading(false); }
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
              <input id={`${inputId}-${key}`} type={key === "since" || key === "until" ? "date" : "text"} required={key === "scope" || key === "left" || key === "right"} value={fields[key]} onChange={e => setFields({ ...fields, [key]: e.target.value })} />
            </label>
          ))}
          <button className="tag-explorer-export" disabled={loading} type="submit">{loading ? "取得中…" : "調査する"}</button>
        </form>
        {error && <p className="tag-explorer-error" role="alert">取得できませんでした。{error}</p>}
        {data && <div aria-live="polite">
          {kind === "search" && request && <p className="tag-explorer-note">適用した条件: 件名・本文「{request.grep}」、作成者「{request.author}」、期間「{request.since} ～ {request.until}」、変更パス「{request.file}」（空欄は条件なし）</p>}
          {data.scope && <p className="tag-explorer-note">検索範囲: <code>{data.scope}</code> ／ {data.offset! + 1}件目から（1ページ50件）</p>}
          {data.left && <p className="tag-explorer-note">A: {data.left} ／ B: {data.right}</p>}
          {data.command && <p className="tag-explorer-note"><code>{data.command}</code></p>}
          {data.unavailable && data.unavailable.length > 0 && <p className="tag-explorer-error" role="alert">一部worktreeを取得できませんでした。重なりの一覧は不完全です: {data.unavailable.join("、")}</p>}
          {data.overlaps && (data.overlaps.length ? (
            <ul className="repository-investigation-list">
              {data.overlaps.map(item => <li className="tag-explorer-commit" key={item.path}>
                <div className="tag-explorer-commit-heading"><strong><code>{item.path}</code></strong></div>
                <ul className="repository-investigation-list">
                  {item.worktrees.map(w => <li className="tag-explorer-commit-meta" key={w.worktree}>
                    <code className="repository-investigation-xy">{w.xy}</code>
                    <span>{w.worktree}</span>
                    <span>{w.branch === null ? "detached HEAD（ブランチなし）" : w.branch.replace(/^refs\/heads\//, "")}</span>
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
          ) : <p className="tag-explorer-empty">該当するコミットはありません。</p>)}
          {kind === "search" && request && <div className="tag-explorer-navigation">
            <button className="tag-explorer-export" type="button" disabled={data.offset === 0} onClick={() => void run(request, data.offset! - 50)}>前の50件</button>
            <button className="tag-explorer-export" type="button" disabled={!data.has_more} onClick={() => void run(request, data.offset! + 50)}>次の50件</button>
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
export function WorktreeOverlaps({ path }: { path: string }) { return <Investigation key={path} path={path} kind="overlaps" />; }
export function CommitSearch({ path }: { path: string }) { return <Investigation key={path} path={path} kind="search" />; }
export function RecoveryCandidates({ path }: { path: string }) { return <Investigation key={path} path={path} kind="recovery" />; }
export function PatchEquivalence({ path }: { path: string }) { return <Investigation key={path} path={path} kind="cherry" />; }

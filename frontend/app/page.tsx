"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRepoStream } from "./repo-stream";
import type { ProjectSummary } from "./types";

function relativeTime(iso: string | null | undefined) {
  if (!iso) return "未取得";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "未取得";
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "たった今";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}時間前`;
  if (seconds < 2_592_000) return `${Math.floor(seconds / 86_400)}日前`;
  return `${Math.floor(seconds / 2_592_000)}ヶ月前`;
}

function exactDate(iso: string | null | undefined) {
  if (!iso) return "未取得";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "未取得" : date.toLocaleString("ja-JP");
}

function remoteLabel(remote: string | null) {
  if (!remote) return "リモート未取得";
  const value = remote.trim();
  const scp =
    !value.includes("://") && value.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  if (scp) return `${scp[1]}/${scp[2].replace(/\.git\/?$/i, "")}`;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return `${url.host}${url.pathname.replace(/\.git\/?$/i, "")}`;
  } catch {
    return value.replace(/\.git\/?$/i, "");
  }
}

function attentionLabel(project: ProjectSummary) {
  if (project.git.conflict > 0) return "conflict を確認";
  if (project.git.dirty > 0) return "変更を確認";
  if (project.git.behind > 0) return "behind を確認";
  if (project.git.ahead > 0) return "ahead を確認";
  return "Git 状態を確認";
}

function ProjectCard({ project }: { project: ProjectSummary }) {
  const target = project.main_path || project.id;
  const href = `/project?path=${encodeURIComponent(target)}&tab=flow&range=current`;
  const hasAttention =
    project.git.conflict > 0 ||
    project.git.dirty > 0 ||
    project.git.behind > 0 ||
    project.git.ahead > 0;
  const latest = project.latest_event;
  return (
    <article className={`project-card${hasAttention ? " project-card-attention" : ""}`}>
      <div className="project-card-topline">
        <span className={hasAttention ? "priority-marker" : "quiet-marker"}>
          {hasAttention ? "要確認" : "観測済み"}
        </span>
        <span className="project-lane-count">
          {project.lane_count === null ? "レーン数 未取得" : `${project.lane_count} レーン`}
        </span>
      </div>
      <div className="project-card-heading">
        <div className="project-card-title-wrap">
          <h2>{project.name}</h2>
          <code title={remoteLabel(project.remote)}>
            {remoteLabel(project.remote)}
          </code>
        </div>
        <Link className="open-project" href={href} aria-label={`${project.name} の管制画面を開く`}>
          開く <span aria-hidden="true">↗</span>
        </Link>
      </div>
      <div className="project-card-facts" aria-label="Git観測値">
        <span className={project.git.conflict > 0 ? "fact fact-danger" : "fact"}>
          conflict {project.git.conflict}
        </span>
        <span className={project.git.dirty > 0 ? "fact fact-warn" : "fact"}>
          変更 {project.git.dirty}
        </span>
        <span className="fact">ahead {project.git.ahead}</span>
        <span className="fact">behind {project.git.behind}</span>
      </div>
      <div className="project-card-agent">
        <span className="agent-dot" aria-hidden="true" />
        <strong>agent 状態不明</strong>
        <span>イベント未取得</span>
      </div>
      <div className="project-card-event">
        <span className="eyebrow">最終 Git イベント</span>
        {latest ? (
          <>
            <strong title={latest.subject}>{latest.subject}</strong>
            <time dateTime={latest.date} title={exactDate(latest.date)}>
              {relativeTime(latest.date)} · {exactDate(latest.date)}
            </time>
          </>
        ) : (
          <strong className="unknown">未取得</strong>
        )}
      </div>
      <div className="project-card-footer">
        <span>
          次に確認: <strong>{project.next_lane ?? "未取得"}</strong>
        </span>
        <span>
          最大差 {project.largest_difference_lane ?? "未取得"} · {attentionLabel(project)}
        </span>
      </div>
    </article>
  );
}

export default function Page() {
  const { repos, scanning, fetching, connected } = useRepoStream();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // The endpoint is intentionally lightweight. Re-fetch after snapshots so a
  // card never treats a worktree count as an agent "running" count.
  const snapshotKey = useMemo(
    () => [...repos.values()]
      .map((repo) => `${repo.path}:${repo.checked_at ?? repo.activity ?? 0}`)
      .sort()
      .join("|"),
    [repos],
  );
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void fetch("/api/projects", { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return (await response.json()) as { projects: ProjectSummary[] };
        })
        .then((value) => {
          if (cancelled) return;
          setProjects(value.projects);
          setLoading(false);
          setError(null);
        })
        .catch((reason: unknown) => {
          if (cancelled) return;
          setLoading(false);
          setError(reason instanceof Error ? reason.message : "unknown error");
        });
    }, snapshotKey ? 120 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [snapshotKey]);

  const visible = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) return projects;
    return projects.filter((project) =>
      [project.name, project.id, project.remote, project.main_path]
        .filter(Boolean)
        .some((item) => item!.toLowerCase().includes(value)),
    );
  }, [projects, query]);
  const totals = useMemo(
    () => ({
      conflicts: projects.reduce((sum, item) => sum + item.git.conflict, 0),
      dirty: projects.reduce((sum, item) => sum + item.git.dirty, 0),
      lanes: projects.every((item) => item.lane_count !== null)
        ? projects.reduce((sum, item) => sum + (item.lane_count ?? 0), 0)
        : null,
    }),
    [projects],
  );

  return (
    <main className="home-shell">
      <header className="home-header">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">gd</span>
          <div>
            <p className="brand-kicker">read-only git observatory</p>
            <h1>gitdash</h1>
          </div>
        </div>
        <div className="connection-state" aria-live="polite">
          <span className={`connection-dot${connected ? " is-on" : ""}`} aria-hidden="true" />
          {connected ? "同期中" : "接続待ち"}
          {scanning && <span> · 走査中</span>}
          {fetching && <span> · fetch 中</span>}
        </div>
      </header>

      <section className="home-intro" aria-labelledby="home-title">
        <div>
          <p className="eyebrow">PROJECT CONTROL BOARD</p>
          <h2 id="home-title">次に判断するプロジェクト</h2>
          <p className="intro-copy">
            Git から観測できる分岐と変更を、プロジェクト単位で確認します。
            agent・PR・CI の情報は接続されるまで未取得として表示します。
          </p>
        </div>
        <div className="home-summary" aria-label="Git観測サマリー">
          <div><strong>{projects.length}</strong><span>プロジェクト</span></div>
          <div><strong>{totals.lanes ?? "?"}</strong><span>Gitレーン</span></div>
          <div><strong>{totals.conflicts + totals.dirty}</strong><span>要確認</span></div>
        </div>
      </section>

      <section className="home-toolbar" aria-label="プロジェクト検索">
        <label className="home-search">
          <span className="sr-only">プロジェクトを検索</span>
          <span aria-hidden="true">⌕</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="プロジェクト、パス、リモートを検索"
            type="search"
          />
        </label>
        <span className="toolbar-note">
          Git変更 {totals.dirty} · conflict {totals.conflicts}
        </span>
      </section>

      {loading && <div className="home-state" role="status">プロジェクトを取得中…</div>}
      {error && (
        <div className="home-state home-state-error" role="alert">
          プロジェクト情報を取得できませんでした。<span className="sr-only">{error}</span>
        </div>
      )}
      {!loading && !error && visible.length === 0 && (
        <div className="home-state">該当するプロジェクトがありません。</div>
      )}
      <section className="project-grid" aria-label="プロジェクト一覧">
        {visible.map((project) => <ProjectCard key={project.id} project={project} />)}
      </section>
      <p className="home-footnote">
        <span className="legend-line" aria-hidden="true" /> 最終 Git イベントの新しい順・問題のある Git 状態を優先表示
      </p>
    </main>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { CommitPane, useCommitDetail, type LoadState } from "./commit-pane";
import TimelineView, { type TimelineRange } from "./timeline-view";
import { classifyBranch } from "./timeline.mjs";
import type { Repo, TimelineResponse } from "./types";
import { stateBadges } from "./status";

type ProjectDetailProps = {
  projectKey: string;
  repos: Repo[];
  copied: string | null;
  onCopy: (value: string) => void;
  onSelectRepo: (path: string) => void;
};

function remoteRepository(remote: string | null | undefined) {
  if (!remote) return "ローカルのみ";
  const value = remote.trim();
  let host: string;
  let path: string;
  const scp = !value.includes("://") && value.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  if (scp) {
    host = scp[1].toLowerCase();
    path = scp[2];
  } else {
    try {
      const url = new URL(value.includes("://") ? value : `https://${value}`);
      host = url.host.toLowerCase();
      path = url.pathname;
    } catch {
      return value.replace(/\.git\/?$/i, "");
    }
  }
  path = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
  return path ? `${host}/${path}` : host;
}

function projectName(projectKey: string, repos: Repo[]) {
  const main = repos.find((repo) => !repo.is_worktree);
  if (main?.name) return main.name;
  const parts = projectKey.split("/").filter(Boolean);
  return parts.at(-1) ?? projectKey;
}

function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  return fetch(url, { cache: "no-store", signal }).then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json() as Promise<T>;
  });
}

function projectBadges(repo: Repo) {
  return stateBadges(repo).map((badge) => (
    <span className={`state-badge token-${badge.token}`} key={`${badge.token}-${badge.text}`}>
      {badge.text}
    </span>
  ));
}

function MemberRow({ repo, onSelect }: { repo: Repo; onSelect: () => void }) {
  return (
    <button className="project-member" type="button" onClick={onSelect}>
      <span className="project-member-kind">{repo.is_worktree ? "worktree" : "本体"}</span>
      <span className="project-member-main">
        <strong>{repo.branch ?? (repo.detached ? "detached HEAD" : repo.name)}</strong>
        <code title={repo.path}>{repo.path}</code>
      </span>
      <span className="project-member-badges" aria-label="状態">
        {projectBadges(repo)}
      </span>
    </button>
  );
}

function Metric({ label, value, token }: { label: string; value: number | string; token?: string }) {
  return (
    <div className={`project-metric${token ? ` project-metric-${token}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export default function ProjectDetail({
  projectKey,
  repos,
  copied,
  onCopy,
  onSelectRepo,
}: ProjectDetailProps) {
  const representative = repos.find((repo) => !repo.is_worktree) ?? repos[0] ?? null;
  const [timeline, setTimeline] = useState<TimelineResponse | null>(null);
  const [timelineState, setTimelineState] = useState<LoadState>("idle");
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [timelineRetry, setTimelineRetry] = useState(0);
  const [range, setRange] = useState<TimelineRange>("7d");
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const commit = useCommitDetail(representative?.path ?? null, selectedHash, timelineState === "ready");
  const dirtyWorktrees = useMemo(
    () => new Map(repos.filter((repo) => repo.is_worktree).map((repo) => [repo.path, repo])),
    [repos],
  );

  useEffect(() => {
    setTimeline(null);
    setTimelineState("idle");
    setTimelineError(null);
    setSelectedHash(null);
  }, [projectKey, representative?.path]);

  useEffect(() => {
    if (!representative) {
      setTimelineState("idle");
      return;
    }
    const controller = new AbortController();
    setTimelineState("loading");
    setTimelineError(null);
    void getJson<TimelineResponse>(
      `/api/repo/timeline?${new URLSearchParams({ path: representative.path })}`,
      controller.signal,
    )
      .then((value) => {
        setTimeline(value);
        setTimelineState("ready");
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setTimelineError(reason instanceof Error ? reason.message : "unknown error");
        setTimelineState("error");
      });
    return () => controller.abort();
  }, [representative?.path, timelineRetry]);

  const metrics = useMemo(() => {
    const statuses = timeline?.branches.map((branch) => classifyBranch(branch, timeline.now, dirtyWorktrees)) ?? [];
    return {
      worktrees: repos.filter((repo) => repo.is_worktree).length,
      working: statuses.filter((status) => status.key === "working").length,
      ready: statuses.filter((status) => status.key === "ready").length,
      behind: statuses.filter((status) => status.key === "behind").length,
      merged: statuses.filter((status) => status.key === "merged").length,
    };
  }, [dirtyWorktrees, repos, timeline]);

  const remote = remoteRepository(representative?.remote);
  const sortedMembers = useMemo(
    () => [...repos].sort((a, b) => {
      if (a.is_worktree !== b.is_worktree) return a.is_worktree ? 1 : -1;
      return (b.activity ?? 0) - (a.activity ?? 0);
    }),
    [repos],
  );

  return (
    <div className="detail project-detail">
      <header className="project-detail-header">
        <div className="project-detail-heading">
          <span className="eyebrow">PROJECT DETAIL</span>
          <h2>{projectName(projectKey, repos)}</h2>
        </div>
        <div className="project-detail-meta">
          <span><strong>remote</strong> {remote}</span>
          <span><strong>common_dir</strong> <code title={projectKey}>{projectKey}</code></span>
          <span><strong>base</strong> {timeline?.base?.name ?? "ベース未設定"}</span>
        </div>
      </header>

      <section className="project-metrics" aria-label="プロジェクトメトリクス">
        <Metric label="worktree 数" value={metrics.worktrees} />
        <Metric label="作業中" value={metrics.working} token="working" />
        <Metric label="Ready" value={metrics.ready} token="ready" />
        <Metric label="Behind" value={metrics.behind} token="behind" />
        <Metric label="merged" value={metrics.merged} token="merged" />
      </section>

      <section className="project-timeline-section" aria-labelledby="project-timeline-title">
        <div className="section-head">
          <div>
            <h3 id="project-timeline-title">ブランチタイムライン</h3>
            {timeline && <code className="cmdhint">{timeline.command}</code>}
          </div>
        </div>
        {timelineState === "loading" && <div className="loading" role="status">タイムラインを取得中…</div>}
        {timelineState === "error" && (
          <div className="inline-error" role="alert">
            タイムラインを取得できませんでした。
            <button className="copy" type="button" onClick={() => setTimelineRetry((value) => value + 1)}>再取得</button>
            {timelineError && <span className="sr-only">{timelineError}</span>}
          </div>
        )}
        {timelineState === "ready" && timeline && timeline.base && (
          <TimelineView
            data={timeline}
            dirtyWorktrees={dirtyWorktrees}
            onRangeChange={setRange}
            onSelect={setSelectedHash}
            range={range}
            selectedHash={selectedHash}
          />
        )}
        {timelineState === "ready" && timeline && !timeline.base && (
          <div className="project-base-missing" role="status">
            <strong>ベース未設定</strong>
            <span>origin/HEAD がないため、ブランチタイムラインを表示できません。</span>
          </div>
        )}
      </section>

      <CommitPane
        detail={commit.detail}
        error={commit.error}
        onCopy={onCopy}
        onRetry={commit.retry}
        state={commit.state}
        title="選択コミット"
      />

      <section className="project-members" aria-labelledby="project-members-title">
        <div className="section-head">
          <div>
            <h3 id="project-members-title">メンバー一覧</h3>
            <span className="cmdhint">本体と linked worktree</span>
          </div>
        </div>
        <div className="project-member-list">
          {sortedMembers.map((repo) => (
            <MemberRow key={repo.path} repo={repo} onSelect={() => onSelectRepo(repo.path)} />
          ))}
          {sortedMembers.length === 0 && <div className="muted-line">メンバーがありません</div>}
        </div>
      </section>
      {copied && <div className="sr-only" role="status">コピーしました</div>}
    </div>
  );
}

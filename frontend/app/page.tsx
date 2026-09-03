"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import RepoDetail from "./repo-detail";
import { Repo, isDirty, hasConflict } from "./types";

type Filter = "all" | "dirty" | "unpushed" | "behind";
type Grouping = "project" | "none" | "parent" | "remote";

function since(iso?: string) {
  if (!iso) return { text: "—", stale: false };
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return { text: "今日", stale: false };
  if (days < 30) return { text: `${days}日前`, stale: days > 14 };
  if (days < 365) return { text: `${Math.floor(days / 30)}ヶ月前`, stale: true };
  return { text: `${Math.floor(days / 365)}年前`, stale: true };
}

function codeColor(xy: string) {
  if (xy === "??") return "var(--c-untracked)";
  if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(xy)) return "var(--c-conflict)";
  if (xy[1] !== ".") return "var(--c-worktree)";
  return "var(--c-index)";
}

/** porcelain v2 の "." を、git status -sb と同じ空白に戻す */
const display = (xy: string) => xy.replace(/\./g, " ");

function BranchLine({ line }: { line: string }) {
  const m = line.match(/^(## [^\[]*)(\[.*\])?$/);
  if (!m) return <span>{line}</span>;
  return (
    <>
      <span className="head">{m[1]}</span>
      {m[2] && <span className="ab">{m[2]}</span>}
    </>
  );
}

/** SSH/HTTPS の表記差を吸収して、同じリモートリポジトリを同じキーにする。 */
function remoteRepository(remote: string | null | undefined) {
  if (!remote) return "ローカルのみ";
  const value = remote.trim();
  let host: string;
  let path: string;

  // git@host:owner/repository.git (scp-like syntax)
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

function groupName(repo: Repo, grouping: Grouping, projectRemotes: Map<string, string>) {
  if (grouping === "project") return repo.common_dir;
  if (grouping === "parent") {
    const slash = repo.path.lastIndexOf("/");
    return slash >= 0 ? repo.path.slice(0, slash) || "/" : "(root)";
  }
  return remoteRepository(repo.remote ?? projectRemotes.get(repo.common_dir));
}

function repoDisplayName(repo: Repo) {
  if (!repo.is_worktree) return repo.name;
  if (repo.branch && !repo.detached && repo.branch !== "(detached)") return repo.branch;
  return repo.detached ? "detached HEAD" : repo.name;
}

function worktreeStateLabel(repo: Repo) {
  if (repo.worktree_state === "prunable") return "prunable";
  if (repo.worktree_state === "locked") return "locked";
  return "worktree";
}

function repoAccessibleName(repo: Repo) {
  const counts = (repo.counts ?? [])
    .map((count) => `${display(count.xy)} ${count.count}`)
    .join(" ");
  return [
    repoDisplayName(repo),
    repo.path,
    repo.is_worktree ? `状態 ${worktreeStateLabel(repo)}` : "本体",
    repo.branch_line,
    counts,
  ].filter(Boolean).join(" ");
}

function sortProjectRepos(a: Repo, b: Repo) {
  if (a.is_worktree !== b.is_worktree) return a.is_worktree ? 1 : -1;
  return (b.activity ?? 0) - (a.activity ?? 0);
}

export default function Page() {
  const [repos, setRepos] = useState<Map<string, Repo>>(new Map());
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [grouping, setGrouping] = useState<Grouping>("project");
  const [open, setOpen] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [connected, setConnected] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const visible = useRef<Set<string>>(new Set());
  const observed = useRef<Map<string, HTMLDivElement>>(new Map());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const upsert = useCallback((repo: Repo) => {
    setRepos((prev) => {
      const next = new Map(prev);
      next.set(repo.path, { ...next.get(repo.path), ...repo });
      return next;
    });
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener("snapshot", (e) => {
      const list: Repo[] = JSON.parse((e as MessageEvent).data);
      setRepos(new Map(list.map((r) => [r.path, r])));
    });
    es.addEventListener("repo", (e) => upsert(JSON.parse((e as MessageEvent).data)));
    es.addEventListener("removed", (e) => {
      const { path } = JSON.parse((e as MessageEvent).data);
      setRepos((prev) => {
        const next = new Map(prev);
        next.delete(path);
        return next;
      });
    });
    es.addEventListener("scan", (e) => setScanning(JSON.parse((e as MessageEvent).data).active));
    es.addEventListener("fetch", (e) => setFetching(JSON.parse((e as MessageEvent).data).active));
    return () => es.close();
  }, [upsert]);

  /** 画面内に入った行を優先して取得させる */
  const flushVisible = useCallback(() => {
    const paths = [...visible.current];
    if (paths.length === 0) return;
    fetch("/api/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths }),
    }).catch(() => undefined);
  }, []);

  const observer = useMemo(() => {
    if (typeof IntersectionObserver === "undefined") return null;
    return new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const path = (entry.target as HTMLElement).dataset.path;
          if (!path) continue;
          if (observed.current.get(path) !== entry.target) continue;
          if (entry.isIntersecting) visible.current.add(path);
          else visible.current.delete(path);
        }
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(flushVisible, 300);
      },
      { rootMargin: "200px" }
    );
  }, [flushVisible]);

  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || !observer) return;
      const path = node.dataset.path;
      if (!path) return;
      const previous = observed.current.get(path);
      if (previous && previous !== node) observer.unobserve(previous);
      observed.current.set(path, node);
      observer.observe(node);
    },
    [observer]
  );

  /** 作業ツリーの編集は inotify で拾えないので、復帰時に取り直す */
  useEffect(() => {
    const onFocus = () => flushVisible();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [flushVisible]);

  const projectRemotes = useMemo(() => {
    const remotes = new Map<string, string>();
    for (const repo of repos.values()) {
      if (repo.remote && (!remotes.has(repo.common_dir) || !repo.is_worktree)) {
        remotes.set(repo.common_dir, repo.remote);
      }
    }
    return remotes;
  }, [repos]);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...repos.values()]
      .filter((r) => {
        if (filter === "dirty" && !isDirty(r)) return false;
        if (filter === "unpushed" && !(r.ahead ?? 0)) return false;
        if (filter === "behind" && !(r.behind ?? 0)) return false;
        if (!q) return true;
        return (
          r.name.toLowerCase().includes(q) ||
          r.path.toLowerCase().includes(q) ||
          (r.branch ?? "").toLowerCase().includes(q) ||
          r.common_dir.toLowerCase().includes(q) ||
          remoteRepository(r.remote ?? projectRemotes.get(r.common_dir)).toLowerCase().includes(q)
        );
      })
      .sort((a, b) => (b.activity ?? 0) - (a.activity ?? 0));
  }, [repos, query, filter, projectRemotes]);

  const all = [...repos.values()];
  const mergedByProject = new Map<string, { checkedAt: number; count: number }>();
  for (const repo of all) {
    const checkedAt = repo.checked_at ?? 0;
    const current = mergedByProject.get(repo.common_dir);
    if (!current || checkedAt >= current.checkedAt) {
      mergedByProject.set(repo.common_dir, {
        checkedAt,
        count: repo.merged_branches?.length ?? 0,
      });
    }
  }
  const stats = {
    projects: new Set(all.map((repo) => repo.common_dir)).size,
    active: all.filter((repo) => !repo.pending && repo.worktree_state !== "prunable").length,
    merged: [...mergedByProject.values()].reduce((count, project) => count + project.count, 0),
    prunable: all.filter((repo) => repo.worktree_state === "prunable").length,
  };

  const copy = (cmd: string) => {
    navigator.clipboard?.writeText(cmd).then(() => {
      setCopied(cmd);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  const groups = useMemo(() => {
    if (grouping === "none") return [{ key: "all", label: null, repos: list }];
    const grouped = new Map<string, Repo[]>();
    for (const repo of list) {
      const key = groupName(repo, grouping, projectRemotes);
      const members = grouped.get(key);
      if (members) members.push(repo);
      else grouped.set(key, [repo]);
    }
    return [...grouped.entries()].map(([key, reposInGroup]) => ({
      key,
      label: key,
      repos: grouping === "project" ? [...reposInGroup].sort(sortProjectRepos) : reposInGroup,
    }));
  }, [grouping, list, projectRemotes]);

  useEffect(() => {
    if (!observer) return;
    for (const [path, node] of observed.current) {
      if (!node.isConnected) {
        observer.unobserve(node);
        observed.current.delete(path);
        visible.current.delete(path);
      }
    }
  }, [groups, observer]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    observer?.disconnect();
    observed.current.clear();
    visible.current.clear();
  }, [observer]);

  const toggleOpen = (path: string) => setOpen((current) => current === path ? null : path);

  return (
    <main className="wrap">
      <header className="masthead">
        <h1>gitdash</h1>
        <div className="meta">
          {repos.size} リポジトリ
          {scanning && " · 走査中"}
          {fetching && " · fetch 中"}
          {!connected && " · 接続待ち"}
        </div>
      </header>

      <div className="cards">
        <div className="card">
          <div className="label">プロジェクト</div>
          <div className="value" style={{ color: "var(--accent)" }}>{stats.projects}</div>
        </div>
        <div className="card">
          <div className="label">作業中ブランチ</div>
          <div className="value" style={{ color: "var(--c-worktree)" }}>{stats.active}</div>
        </div>
        <div className="card">
          <div className="label">merged 未削除</div>
          <div className="value" style={{ color: "var(--c-behind)" }}>{stats.merged}</div>
        </div>
        <div className="card">
          <div className="label">prunable</div>
          <div className="value" style={{ color: "var(--c-conflict)" }}>{stats.prunable}</div>
        </div>
      </div>

      <div className="toolbar">
        <input
          className="search"
          aria-label="名前、パス、ブランチで検索"
          placeholder="名前、パス、ブランチ"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="button" className="chip" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>すべて</button>
        <button type="button" className="chip" aria-pressed={filter === "dirty"} onClick={() => setFilter("dirty")}>変更あり</button>
        <button type="button" className="chip" aria-pressed={filter === "unpushed"} onClick={() => setFilter("unpushed")}>ahead</button>
        <button type="button" className="chip" aria-pressed={filter === "behind"} onClick={() => setFilter("behind")}>behind</button>
        <label className="group-select">
          <span>グループ</span>
          <select aria-label="リポジトリのグループ" value={grouping} onChange={(e) => setGrouping(e.target.value as Grouping)}>
            <option value="project">プロジェクト</option>
            <option value="none">なし</option>
            <option value="parent">親フォルダ</option>
            <option value="remote">リモート（リポジトリ）</option>
          </select>
        </label>
        <button
          type="button"
          className="refresh"
          disabled={scanning}
          onClick={() => fetch("/api/rescan", { method: "POST" })}
        >
          {scanning ? "走査中…" : "再走査"}
        </button>
      </div>

      <div className="cmdhint">git status -sb</div>

      <section className={grouping === "none" ? "repo-group ungrouped" : "repo-group"}>
        {groups.flatMap((group) => [
          ...(group.label ? [
            <div className="group-heading" key={`group-heading-${group.key}`}>
              <div className="group-heading-main">
                <h2>{group.label}</h2>
                {grouping === "project" && <code className="cmdhint group-command">git worktree list</code>}
              </div>
              <span>{group.repos.length}</span>
            </div>,
          ] : []),
          ...group.repos.map((r) => {
            const s = since(r.last_commit?.date);
            const projectWorktree = grouping === "project" && r.is_worktree;
            const cls = [
              "row",
              r.pending ? "pending" : "",
              r.worktree_state === "prunable" ? "prunable" : r.worktree_state === "locked" ? "locked" : "",
              hasConflict(r) ? "conflict" : isDirty(r) ? "dirty" : (r.ahead ?? 0) ? "unpushed" : (r.behind ?? 0) ? "behind" : "",
            ].filter(Boolean).join(" ");

            return (
              <div className={projectWorktree ? "repo-item worktree-item" : "repo-item"} key={r.path}>
                <div
                  className={cls}
                  data-path={r.path}
                  ref={attach}
                  role="button"
                  tabIndex={0}
                  aria-expanded={open === r.path}
                  aria-label={repoAccessibleName(r)}
                  onClick={() => toggleOpen(r.path)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      toggleOpen(r.path);
                    }
                  }}
                >
                  <div>
                    <div className="row-primary">
                      <div className="name">{repoDisplayName(r)}</div>
                      {r.is_worktree && (
                        <span className={`row-kind row-kind-${r.worktree_state ?? "ok"}`}>
                          {worktreeStateLabel(r)}
                        </span>
                      )}
                    </div>
                    <div className="path" title={r.path}>{r.path}</div>
                  </div>
                  <div className="bline" title={r.branch_line}>
                    {r.branch_line ? <BranchLine line={r.branch_line} /> : "—"}
                  </div>
                  <div className="codes">
                    {(r.counts ?? []).map((c) => (
                      <span key={c.xy} style={{ color: codeColor(c.xy) }}>
                        {display(c.xy)} {c.count}
                      </span>
                    ))}
                    {(r.stashes ?? 0) > 0 && (
                      <span style={{ color: "var(--c-behind)" }}>stash {r.stashes}</span>
                    )}
                    {!r.pending && (r.counts?.length ?? 0) === 0 && (r.stashes ?? 0) === 0 && (
                      <span style={{ color: "var(--muted)" }}>clean</span>
                    )}
                  </div>
                  <div className={s.stale ? "when stale" : "when"}>{s.text}</div>
                </div>

                {open === r.path && (
                  <RepoDetail repo={r} copied={copied} onCopy={copy} />
                )}
              </div>
            );
          }),
        ])}
      </section>

      {list.length === 0 && (
        <div className="empty">
          {scanning ? "走査中です" : "該当するリポジトリがありません"}
        </div>
      )}
    </main>
  );
}

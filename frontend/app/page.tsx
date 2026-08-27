"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import RepoDetail from "./repo-detail";
import { Repo, isDirty, hasConflict } from "./types";

type Filter = "all" | "dirty" | "unpushed" | "behind";
type Grouping = "none" | "parent" | "remote";

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

function remoteHost(remote: string | null | undefined) {
  if (!remote) return "ローカルのみ";
  const scp = remote.match(/^git@([^:]+):/);
  if (scp) return scp[1];
  try {
    return new URL(remote).hostname;
  } catch {
    return remote;
  }
}

function groupName(repo: Repo, grouping: Grouping) {
  if (grouping === "parent") {
    const slash = repo.path.lastIndexOf("/");
    return slash >= 0 ? repo.path.slice(0, slash) || "/" : "(root)";
  }
  return remoteHost(repo.remote);
}

export default function Page() {
  const [repos, setRepos] = useState<Map<string, Repo>>(new Map());
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [grouping, setGrouping] = useState<Grouping>("none");
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
          (r.branch ?? "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) => (b.activity ?? 0) - (a.activity ?? 0));
  }, [repos, query, filter]);

  const all = [...repos.values()];
  const stats = {
    dirty: all.filter(isDirty).length,
    ahead: all.filter((r) => (r.ahead ?? 0) > 0).length,
    behind: all.filter((r) => (r.behind ?? 0) > 0).length,
    diverged: all.filter((r) => r.diverged).length,
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
      const key = groupName(repo, grouping);
      const members = grouped.get(key);
      if (members) members.push(repo);
      else grouped.set(key, [repo]);
    }
    return [...grouped.entries()].map(([key, reposInGroup]) => ({
      key,
      label: key,
      repos: reposInGroup,
    }));
  }, [grouping, list]);

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
          <div className="label">変更あり</div>
          <div className="value" style={{ color: "var(--c-worktree)" }}>{stats.dirty}</div>
        </div>
        <div className="card">
          <div className="label">ahead</div>
          <div className="value" style={{ color: "var(--c-ahead)" }}>{stats.ahead}</div>
        </div>
        <div className="card">
          <div className="label">behind</div>
          <div className="value" style={{ color: "var(--c-behind)" }}>{stats.behind}</div>
        </div>
        <div className="card">
          <div className="label">分岐</div>
          <div className="value" style={{ color: "var(--c-conflict)" }}>{stats.diverged}</div>
        </div>
      </div>

      <div className="toolbar">
        <input
          className="search"
          placeholder="名前、パス、ブランチ"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="chip" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>すべて</button>
        <button className="chip" aria-pressed={filter === "dirty"} onClick={() => setFilter("dirty")}>変更あり</button>
        <button className="chip" aria-pressed={filter === "unpushed"} onClick={() => setFilter("unpushed")}>ahead</button>
        <button className="chip" aria-pressed={filter === "behind"} onClick={() => setFilter("behind")}>behind</button>
        <label className="group-select">
          <span>グループ</span>
          <select aria-label="リポジトリのグループ" value={grouping} onChange={(e) => setGrouping(e.target.value as Grouping)}>
            <option value="none">なし</option>
            <option value="parent">親フォルダ</option>
            <option value="remote">リモート</option>
          </select>
        </label>
        <button
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
              <h2>{group.label}</h2>
              <span>{group.repos.length}</span>
            </div>,
          ] : []),
          ...group.repos.map((r) => {
            const s = since(r.last_commit?.date);
            const cls = [
              "row",
              r.pending ? "pending" : "",
              hasConflict(r) ? "conflict" : isDirty(r) ? "dirty" : (r.ahead ?? 0) ? "unpushed" : (r.behind ?? 0) ? "behind" : "",
            ].filter(Boolean).join(" ");

            return (
              <div key={r.path}>
                <div
                  className={cls}
                  data-path={r.path}
                  ref={attach}
                  role="button"
                  tabIndex={0}
                  aria-expanded={open === r.path}
                  onClick={() => toggleOpen(r.path)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      toggleOpen(r.path);
                    }
                  }}
                >
                  <div>
                    <div className="name">{r.name}</div>
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

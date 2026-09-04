"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import RepoDetail, { type DetailTab } from "./repo-detail";
import ProjectDetail from "./project-detail";
import { hasConflict, isDirty, type Repo } from "./types";
import { stateBadges } from "./status";

type Filter =
  | "all"
  | "dirty"
  | "unpushed"
  | "behind"
  | "worktree"
  | "merged"
  | "prunable"
  | "active";
type Grouping = "project" | "none" | "parent" | "remote";
type Selection =
  | { type: "repo"; path: string }
  | { type: "project"; commonDir: string };

function since(iso?: string) {
  if (!iso) return { text: "—", stale: false };
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return { text: "今日", stale: false };
  if (days < 30) return { text: `${days}日前`, stale: days > 14 };
  if (days < 365)
    return { text: `${Math.floor(days / 30)}ヶ月前`, stale: true };
  return { text: `${Math.floor(days / 365)}年前`, stale: true };
}

function remoteRepository(remote: string | null | undefined) {
  if (!remote) return "ローカルのみ";
  const value = remote.trim();
  let host: string;
  let path: string;
  const scp =
    !value.includes("://") && value.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
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
  path = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  return path ? `${host}/${path}` : host;
}

function repoDisplayName(repo: Repo) {
  if (!repo.is_worktree)
    return repo.branch && !repo.detached ? repo.branch : repo.name;
  if (repo.branch && !repo.detached && repo.branch !== "(detached)")
    return repo.branch;
  return repo.detached ? "detached HEAD" : repo.name;
}
function trackingSummary(repo: Repo) {
  const values = [];
  if ((repo.ahead ?? 0) > 0) values.push(`ahead ${repo.ahead}`);
  if ((repo.behind ?? 0) > 0) values.push(`behind ${repo.behind}`);
  return values.length ? `[${values.join(", ")}]` : "—";
}
function worktreeStateLabel(repo: Repo) {
  return repo.worktree_state === "prunable"
    ? "prunable"
    : repo.worktree_state === "locked"
      ? "locked"
      : "worktree";
}
function groupName(
  repo: Repo,
  grouping: Grouping,
  projectRemotes: Map<string, string>,
) {
  if (grouping === "project") return repo.common_dir;
  if (grouping === "parent") {
    const slash = repo.path.lastIndexOf("/");
    return slash >= 0 ? repo.path.slice(0, slash) || "/" : "(root)";
  }
  return remoteRepository(repo.remote ?? projectRemotes.get(repo.common_dir));
}
function projectSort(a: Repo, b: Repo) {
  const aPrunable = a.worktree_state === "prunable";
  const bPrunable = b.worktree_state === "prunable";
  if (aPrunable !== bPrunable) return aPrunable ? 1 : -1;
  if (a.is_worktree !== b.is_worktree) return a.is_worktree ? 1 : -1;
  return (b.activity ?? 0) - (a.activity ?? 0);
}
function matches(repo: Repo, filter: Filter) {
  if (filter === "all") return true;
  if (filter === "dirty") return isDirty(repo);
  if (filter === "unpushed") return (repo.ahead ?? 0) > 0;
  if (filter === "behind") return (repo.behind ?? 0) > 0;
  if (filter === "worktree") return repo.is_worktree;
  if (filter === "merged")
    return Boolean(
      repo.merged ||
        (!repo.is_worktree && (repo.merged_branches?.length ?? 0) > 0),
    );
  if (filter === "prunable") return repo.worktree_state === "prunable";
  return repo.is_worktree;
}
function repoAccessibleName(repo: Repo) {
  return [
    repoDisplayName(repo),
    repo.path,
    repo.branch_line,
    ...stateBadges(repo).map((badge) => badge.text),
  ]
    .filter(Boolean)
    .join(" ");
}
function mergedCount(repos: Repo[]) {
  const branches = new Set<string>();
  for (const repo of repos) {
    for (const branch of repo.merged_branches ?? []) branches.add(branch);
    if (repo.is_worktree && repo.merged && repo.branch)
      branches.add(repo.branch);
  }
  return branches.size;
}
function projectDisplay(repos: Repo[], key: string) {
  const main = repos.find((repo) => !repo.is_worktree);
  const latest = Math.max(...repos.map((repo) => repo.activity ?? 0), 0);
  const remote = remoteRepository(main?.remote);
  return {
    name: main?.name ?? key.split("/").pop() ?? key,
    remote: remote.replace(/^[^/]+\//, ""),
    worktrees: repos.filter((repo) => repo.is_worktree).length,
    merged: mergedCount(repos),
    prunable: repos.filter((repo) => repo.worktree_state === "prunable").length,
    recent:
      latest > 0 ? since(new Date(latest * 1000).toISOString()).text : "—",
  };
}
function BadgeList({ repo }: { repo: Repo }) {
  return (
    <div className="codes" aria-label="状態">
      {stateBadges(repo).map((badge) => (
        <span
          className={`state-badge token-${badge.token}`}
          key={`${badge.token}-${badge.text}`}
        >
          {badge.text}
        </span>
      ))}
    </div>
  );
}

export default function Page() {
  const [repos, setRepos] = useState<Map<string, Repo>>(new Map());
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [grouping, setGrouping] = useState<Grouping>("project");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [activeTab, setActiveTab] = useState<DetailTab>("graph");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [connected, setConnected] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const lastFocused = useRef<string | null>(null);
  const upsert = useCallback(
    (repo: Repo) =>
      setRepos((prev) => {
        const next = new Map(prev);
        next.set(repo.path, { ...next.get(repo.path), ...repo });
        return next;
      }),
    [],
  );
  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener("snapshot", (event) => {
      const list: Repo[] = JSON.parse((event as MessageEvent).data);
      setRepos(new Map(list.map((repo) => [repo.path, repo])));
    });
    es.addEventListener("repo", (event) =>
      upsert(JSON.parse((event as MessageEvent).data)),
    );
    es.addEventListener("removed", (event) =>
      setRepos((prev) => {
        const next = new Map(prev);
        next.delete(JSON.parse((event as MessageEvent).data).path);
        return next;
      }),
    );
    es.addEventListener("scan", (event) =>
      setScanning(JSON.parse((event as MessageEvent).data).active),
    );
    es.addEventListener("fetch", (event) =>
      setFetching(JSON.parse((event as MessageEvent).data).active),
    );
    return () => es.close();
  }, [upsert]);

  const visible = useRef<Set<string>>(new Set());
  const observed = useRef<Map<string, HTMLDivElement>>(new Map());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushVisible = useCallback(() => {
    const paths = [...visible.current];
    if (!paths.length) return;
    fetch("/api/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths }),
    }).catch(() => undefined);
  }, []);
  const observer = useMemo(
    () =>
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            (entries) => {
              for (const entry of entries) {
                const path = (entry.target as HTMLElement).dataset.path;
                if (!path || observed.current.get(path) !== entry.target)
                  continue;
                if (entry.isIntersecting) visible.current.add(path);
                else visible.current.delete(path);
              }
              if (timer.current) clearTimeout(timer.current);
              timer.current = setTimeout(flushVisible, 300);
            },
            { rootMargin: "200px" },
          ),
    [flushVisible],
  );
  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || !observer) return;
      const path = node.dataset.path;
      if (!path) return;
      const old = observed.current.get(path);
      if (old && old !== node) observer.unobserve(old);
      observed.current.set(path, node);
      observer.observe(node);
    },
    [observer],
  );
  useEffect(() => {
    const onFocus = () => flushVisible();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [flushVisible]);

  const all = [...repos.values()];
  const projectRemotes = useMemo(() => {
    const map = new Map<string, string>();
    for (const repo of repos.values())
      if (repo.remote && (!map.has(repo.common_dir) || !repo.is_worktree))
        map.set(repo.common_dir, repo.remote);
    return map;
  }, [repos]);
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const searched = all.filter(
      (repo) =>
        !q ||
        [
          repo.name,
          repo.path,
          repo.branch,
          repo.common_dir,
          remoteRepository(repo.remote ?? projectRemotes.get(repo.common_dir)),
        ].some((value) => value?.toLowerCase().includes(q)),
    );
    if (grouping === "none")
      return [
        {
          key: "all",
          label: null,
          allRepos: searched,
          repos: searched
            .filter((repo) => matches(repo, filter))
            .sort((a, b) => (b.activity ?? 0) - (a.activity ?? 0)),
        },
      ];
    const map = new Map<string, Repo[]>();
    for (const repo of searched) {
      const key = groupName(repo, grouping, projectRemotes);
      map.set(key, [...(map.get(key) ?? []), repo]);
    }
    return [...map.entries()]
      .map(([key, members]) => {
        const matching = members.filter((repo) => matches(repo, filter));
        const parent = members.find((repo) => !repo.is_worktree);
        const kept =
          grouping === "project" &&
          filter !== "all" &&
          matching.some((repo) => repo.is_worktree)
            ? [...new Set([...(parent ? [parent] : []), ...matching])]
            : matching;
        return {
          key,
          label: key,
          allRepos: members,
          repos: kept.sort(projectSort),
        };
      })
      .sort(
        (a, b) =>
          Math.max(...b.allRepos.map((repo) => repo.activity ?? 0), 0) -
          Math.max(...a.allRepos.map((repo) => repo.activity ?? 0), 0),
      )
      .filter((group) => group.repos.length > 0);
  }, [all, filter, grouping, projectRemotes, query]);
  const projectKeys = useMemo(
    () => new Set([...repos.values()].map((repo) => repo.common_dir)),
    [repos],
  );
  const stats = {
    projects: new Set(all.map((repo) => repo.common_dir)).size,
    worktrees: all.length,
    active: all.filter((repo) => repo.is_worktree).length,
    dirty: all.filter(isDirty).length,
    merged: [...projectKeys].reduce(
      (count, key) =>
        count + mergedCount(all.filter((repo) => repo.common_dir === key)),
      0,
    ),
    prunable: all.filter((repo) => repo.worktree_state === "prunable").length,
  };
  const selectedPath = selection?.type === "repo" ? selection.path : null;
  const selected = selectedPath ? (repos.get(selectedPath) ?? null) : null;
  const selectedProject =
    selection?.type === "project"
      ? all.filter((repo) => repo.common_dir === selection.commonDir)
      : [];
  const hasSelection = Boolean(selected) || selectedProject.length > 0;
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const path = params.get("repo");
    const project = params.get("project");
    const tab = params.get("tab");
    if (project && projectKeys.has(project))
      setSelection({ type: "project", commonDir: project });
    else if (path && repos.has(path)) setSelection({ type: "repo", path });
    if (tab === "status" || tab === "graph" || tab === "branches")
      setActiveTab(tab);
  }, [projectKeys, repos]);
  const updateUrl = useCallback(
    (nextSelection: Selection | null, tab: DetailTab | null) => {
      const url = new URL(window.location.href);
      url.searchParams.delete("repo");
      url.searchParams.delete("project");
      if (nextSelection?.type === "repo") url.searchParams.set("repo", nextSelection.path);
      if (nextSelection?.type === "project")
        url.searchParams.set("project", nextSelection.commonDir);
      if (nextSelection?.type === "repo" && tab) url.searchParams.set("tab", tab);
      else url.searchParams.delete("tab");
      window.history.replaceState({}, "", url);
    },
    [],
  );
  const selectRepo = useCallback(
    (path: string) => {
      lastFocused.current = path;
      const nextSelection: Selection = { type: "repo", path };
      setSelection(nextSelection);
      setActiveTab("graph");
      updateUrl(nextSelection, "graph");
    },
    [updateUrl],
  );
  const selectProject = useCallback(
    (commonDir: string) => {
      const nextSelection: Selection = { type: "project", commonDir };
      setSelection(nextSelection);
      updateUrl(nextSelection, null);
    },
    [updateUrl],
  );
  const closeDetail = useCallback(() => {
    setSelection(null);
    updateUrl(null, null);
    window.setTimeout(() => {
      if (lastFocused.current)
        rowRefs.current.get(lastFocused.current)?.focus();
    }, 0);
  }, [updateUrl]);
  const changeTab = useCallback(
    (tab: DetailTab) => {
      setActiveTab(tab);
      if (selection?.type === "repo") updateUrl(selection, tab);
    },
    [selection, updateUrl],
  );
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && selection) {
        event.preventDefault();
        closeDetail();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeDetail, selection]);
  const copy = (value: string) =>
    navigator.clipboard?.writeText(value).then(() => {
      setCopied(value);
      window.setTimeout(() => setCopied(null), 1500);
    });
  const rowKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
    path: string,
  ) => {
    const index = renderedRows.findIndex((repo) => repo.path === path);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = renderedRows[index + (event.key === "ArrowDown" ? 1 : -1)];
      if (next) {
        lastFocused.current = next.path;
        rowRefs.current.get(next.path)?.focus();
      }
    }
    if (event.key === "Enter") {
      event.preventDefault();
      selectRepo(path);
    }
  };
  const card = (
    label: string,
    value: number,
    token: string,
    onClick?: () => void,
  ) => (
    <button
      className={`card card-${token}`}
      type="button"
      onClick={onClick}
      aria-pressed={onClick ? filter === token : undefined}
    >
      <span className="label">{label}</span>
      <span className="value">{value}</span>
    </button>
  );

  const renderedRows = useMemo(
    () =>
      groups.flatMap((group) => {
        const isProject = grouping === "project";
        const hasWorktree = group.repos.some((repo) => repo.is_worktree);
        const isOpen = !isProject || !expanded.has(group.key);
        const children = isOpen ? group.repos : group.repos.slice(0, 1);
        const worktrees = children.filter((repo) => repo.is_worktree);
        return revealed.has(group.key)
          ? children
          : children.filter(
              (repo) => !repo.is_worktree || worktrees.indexOf(repo) < 6,
            );
      }),
    [expanded, grouping, groups, revealed],
  );
  const flatRows = renderedRows;
  return (
    <main className="wrap">
      <header className="masthead">
        <h1>gitdash</h1>
        <div className="meta">
          {stats.projects} プロジェクト · {stats.worktrees} 作業ツリー
          {scanning && " · 走査中"}
          {fetching && " · fetch 中"}
          {!connected && " · 接続待ち"}
        </div>
      </header>
      <div className="cards">
        {card("作業中", stats.active, "active", () =>
          setFilter((current) => (current === "active" ? "all" : "active")),
        )}
        {card("変更あり", stats.dirty, "dirty", () =>
          setFilter((current) => (current === "dirty" ? "all" : "dirty")),
        )}
        {card("merged 未削除", stats.merged, "merged", () =>
          setFilter((current) => (current === "merged" ? "all" : "merged")),
        )}
        {card("prunable", stats.prunable, "prunable", () =>
          setFilter((current) => (current === "prunable" ? "all" : "prunable")),
        )}
      </div>
      <div className="toolbar">
        <input
          className="search"
          aria-label="名前、パス、ブランチで検索"
          placeholder="名前、パス、ブランチ"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {(
          [
            "all",
            "dirty",
            "unpushed",
            "behind",
            "worktree",
            "merged",
            "prunable",
          ] as Filter[]
        ).map((item) => (
          <button
            type="button"
            className="chip"
            key={item}
            aria-pressed={filter === item}
            onClick={() => setFilter(item)}
          >
            {item === "all"
              ? "すべて"
              : item === "dirty"
                ? "変更あり"
                : item === "unpushed"
                  ? "ahead"
                  : item}
          </button>
        ))}
        <label className="group-select">
          <span>グループ</span>
          <select
            aria-label="リポジトリのグループ"
            value={grouping}
            onChange={(event) => setGrouping(event.target.value as Grouping)}
          >
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
      <div className={`board-layout${hasSelection ? " has-selection" : ""}`}>
        <section className="repo-group" aria-label="リポジトリ一覧">
          {groups.flatMap((group) => {
            const isProject = grouping === "project";
            const hasWorktree = group.allRepos.some((repo) => repo.is_worktree);
            const showHeader =
              Boolean(group.label) &&
              (isProject || hasWorktree || group.repos.length > 1);
            const isOpen = !isProject || !expanded.has(group.key);
            const children = isOpen ? group.repos : group.repos.slice(0, 1);
            const worktrees = children.filter((repo) => repo.is_worktree);
            const rows = revealed.has(group.key)
              ? children
              : children.filter(
                  (repo) => !repo.is_worktree || worktrees.indexOf(repo) < 6,
                );
            const project = projectDisplay(group.allRepos, group.key);
            return [
              showHeader ? (
                isProject ? (
                  <div
                    className={`group-heading project-heading${selection?.type === "project" && selection.commonDir === group.key ? " project-heading-selected" : ""}`}
                    key={`heading-${group.key}`}
                  >
                    <div className="project-primary-actions">
                      <button
                        type="button"
                        className="project-collapse"
                        aria-label={`${project.name} を${isOpen ? "折りたたむ" : "展開する"}`}
                        aria-expanded={isOpen}
                        onClick={() =>
                          setExpanded((current) => {
                            const next = new Set(current);
                            if (next.has(group.key)) next.delete(group.key);
                            else next.add(group.key);
                            return next;
                          })
                        }
                      >
                        <span aria-hidden="true">{isOpen ? "▼" : "▶"}</span>
                      </button>
                      <button
                        type="button"
                        className="project-toggle"
                        onClick={() => selectProject(group.key)}
                      >
                        <span className="project-primary">
                          <strong title={group.key}>{project.name}</strong>
                          <span title={project.remote}>{project.remote}</span>
                        </span>
                      </button>
                    </div>
                    <span className="project-empty">—</span>
                    <span className="project-summary">
                      {project.worktrees} worktree · merged {project.merged} ·
                      prunable {project.prunable}
                    </span>
                    <span className="project-activity">{project.recent}</span>
                  </div>
                ) : (
                  <div className="group-heading" key={`heading-${group.key}`}>
                    <div className="group-heading-main">
                      <h2 title={group.key}>{group.label}</h2>
                    </div>
                    <span>{group.repos.length}</span>
                  </div>
                )
              ) : null,
              ...rows.map((repo) => {
                const stale = since(repo.last_commit?.date);
                const classes = [
                  "row",
                  repo.path === selectedPath ? "row-selected" : "",
                  repo.pending ? "pending" : "",
                  repo.worktree_state === "prunable"
                    ? "prunable"
                    : repo.worktree_state === "locked"
                      ? "locked"
                      : "",
                  hasConflict(repo)
                    ? "conflict"
                    : isDirty(repo)
                      ? "dirty"
                      : (repo.ahead ?? 0)
                        ? "unpushed"
                        : (repo.behind ?? 0)
                          ? "behind"
                          : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                const isLastVisibleWorktree =
                  repo.is_worktree &&
                  rows.findLast((candidate) => candidate.is_worktree)?.path ===
                    repo.path &&
                  (revealed.has(group.key) || worktrees.length <= 6);
                return (
                  <div
                    className={
                      repo.is_worktree && isProject
                        ? `repo-item worktree-item${isLastVisibleWorktree ? " worktree-last" : ""}`
                        : isProject && hasWorktree
                          ? "repo-item main-item"
                          : "repo-item"
                    }
                    key={repo.path}
                  >
                    <div
                      className={classes}
                      data-path={repo.path}
                      ref={(node) => {
                        attach(node);
                        if (node) rowRefs.current.set(repo.path, node);
                        else rowRefs.current.delete(repo.path);
                      }}
                      role="button"
                      tabIndex={
                        repo.path === selectedPath ||
                        flatRows[0]?.path === repo.path
                          ? 0
                          : -1
                      }
                      aria-current={
                        repo.path === selectedPath ? "true" : undefined
                      }
                      aria-label={repoAccessibleName(repo)}
                      onClick={() => selectRepo(repo.path)}
                      onKeyDown={(event) => rowKeyDown(event, repo.path)}
                    >
                      <div>
                        <div className="row-primary">
                          <div className="name" title={repoDisplayName(repo)}>
                            {repoDisplayName(repo)}
                          </div>
                          {repo.is_worktree && (
                            <span
                              className={`row-kind row-kind-${repo.worktree_state ?? "ok"}`}
                            >
                              {worktreeStateLabel(repo)}
                            </span>
                          )}
                        </div>
                        <div className="path" title={repo.path}>
                          {repo.path}
                        </div>
                      </div>
                      <div
                        className="bline"
                        title={
                          repo.is_worktree
                            ? trackingSummary(repo)
                            : repo.branch_line
                        }
                      >
                        {repo.is_worktree
                          ? trackingSummary(repo)
                          : repo.branch_line || "—"}
                      </div>
                      <BadgeList repo={repo} />
                      <div className={stale.stale ? "when stale" : "when"}>
                        {stale.text}
                      </div>
                    </div>
                  </div>
                );
              }),
              isOpen &&
              isProject &&
              hasWorktree &&
              group.repos.filter((repo) => repo.is_worktree).length > 6 &&
              !revealed.has(group.key) ? (
                <button
                  className="more-worktrees"
                  key={`more-${group.key}`}
                  type="button"
                  onClick={() =>
                    setRevealed((current) => new Set(current).add(group.key))
                  }
                >
                  {group.repos.filter((repo) => repo.is_worktree).length - 6}{" "}
                  件を表示
                </button>
              ) : null,
            ];
          })}
        </section>
        {hasSelection && selection && (
          <aside
            className="detail-pane"
            aria-label={selection.type === "project" ? "プロジェクト詳細" : "リポジトリ詳細"}
          >
            {selection.type === "repo" && selected ? (
              <RepoDetail
                repo={selected}
                copied={copied}
                onCopy={copy}
                onProjectSelect={() => selectProject(selected.common_dir)}
                activeTab={activeTab}
                onTabChange={changeTab}
              />
            ) : selection.type === "project" ? (
              <ProjectDetail
                projectKey={selection.commonDir}
                repos={selectedProject}
                copied={copied}
                onCopy={copy}
                onSelectRepo={selectRepo}
              />
            ) : null}
            <button
              className="detail-close"
              type="button"
              onClick={closeDetail}
              aria-label="詳細を閉じる"
            >
              Esc 閉じる
            </button>
          </aside>
        )}
      </div>
      {hasSelection && (
        <div
          className="detail-scrim"
          aria-hidden="true"
          onClick={closeDetail}
        />
      )}{" "}
      {!flatRows.length && (
        <div className="empty">
          {scanning ? "走査中です" : "該当するリポジトリがありません"}
        </div>
      )}
    </main>
  );
}

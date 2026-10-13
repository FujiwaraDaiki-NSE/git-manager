"use client";

import "./project-switcher.css";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { FAVORITES_STORAGE_KEY, parseFavoriteIds } from "./home-overview.mjs";
import {
  PROJECT_SWITCHER_ORDERS,
  RECENT_PROJECT_PATHS_STORAGE_KEY,
  filterProjectSwitcherProjects,
  parseRecentProjectPaths,
  projectSwitcherResultIndex,
  recordRecentProjectPath,
  serializeRecentProjectPaths,
  sortProjectSwitcherProjects,
} from "./project-switcher-tools.mjs";
import type { ProjectSummary } from "./types";

type ProjectSwitcherOrder = "recent" | "name";

function resultAnchors(dialog: HTMLDialogElement | null) {
  return dialog
    ? Array.from(dialog.querySelectorAll<HTMLAnchorElement>("[data-project-switch-result]"))
    : [];
}

function focusResult(dialog: HTMLDialogElement | null, index: number) {
  resultAnchors(dialog)[index]?.focus();
}

export default function ProjectSwitcher({ currentPath, homeQuery }: { currentPath: string | null; homeQuery: string | null }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [favoritesStorageIssue, setFavoritesStorageIssue] = useState(false);
  const [recentPaths, setRecentPaths] = useState<string[]>([]);
  const [recentReady, setRecentReady] = useState(false);
  const [recentStorageIssue, setRecentStorageIssue] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [recentOnly, setRecentOnly] = useState(false);
  const [order, setOrder] = useState<ProjectSwitcherOrder>("recent");
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const recentPathsRef = useRef<string[]>([]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k" && !event.isComposing) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);

  useEffect(() => {
    if (!open) {
      dialog.current?.close();
      if (wasOpen.current) {
        wasOpen.current = false;
        trigger.current?.focus();
      }
      return;
    }
    wasOpen.current = true;
    if (!dialog.current?.open) dialog.current?.showModal();
    input.current?.focus();
    setQuery("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(false);
    const controller = new AbortController();
    void fetch("/api/projects", { cache: "no-store", signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error(); return await response.json() as { projects: ProjectSummary[] }; })
      .then((value) => { if (!controller.signal.aborted) { setProjects(value.projects); setLoading(false); } })
      .catch(() => { if (!controller.signal.aborted) { setError(true); setLoading(false); } });
    return () => controller.abort();
  }, [open, reload]);

  useEffect(() => {
    if (!open) return;
    let raw: string | null;
    try {
      raw = window.localStorage.getItem(FAVORITES_STORAGE_KEY);
    } catch {
      setFavoritesStorageIssue(true);
      return;
    }
    const parsed = parseFavoriteIds(raw);
    if (parsed === null) {
      setFavoritesStorageIssue(true);
      return;
    }
    setFavorites(new Set(parsed));
    setFavoritesStorageIssue(false);
  }, [open]);

  useEffect(() => {
    let raw: string | null;
    try {
      raw = window.localStorage.getItem(RECENT_PROJECT_PATHS_STORAGE_KEY);
    } catch {
      setRecentStorageIssue(true);
      setRecentReady(true);
      return;
    }
    const parsed = parseRecentProjectPaths(raw);
    if (parsed === null) {
      setRecentStorageIssue(true);
      setRecentReady(true);
      return;
    }
    recentPathsRef.current = parsed;
    setRecentPaths(parsed);
    setRecentReady(true);
  }, []);

  const rememberRecentPath = (path: string | null) => {
    if (path === null || !recentReady) return;
    const next = recordRecentProjectPath(recentPathsRef.current, path);
    if (next.length === recentPathsRef.current.length && next.every((item, index) => item === recentPathsRef.current[index])) return;
    recentPathsRef.current = next;
    setRecentPaths(next);
    if (recentStorageIssue) return;
    try {
      window.localStorage.setItem(RECENT_PROJECT_PATHS_STORAGE_KEY, serializeRecentProjectPaths(next));
    } catch {
      setRecentStorageIssue(true);
    }
  };

  useEffect(() => {
    rememberRecentPath(currentPath);
    // currentPath and the completed initial read are the only events that
    // should record a visit. A storage error stays visible until cleared.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath, recentReady]);

  const clearRecentHistory = () => {
    recentPathsRef.current = [];
    setRecentPaths([]);
    try {
      window.localStorage.removeItem(RECENT_PROJECT_PATHS_STORAGE_KEY);
      setRecentStorageIssue(false);
    } catch {
      setRecentStorageIssue(true);
    }
  };

  const filteredProjects = useMemo(() => filterProjectSwitcherProjects(projects, {
    query,
    favoritesOnly,
    recentOnly,
    favoriteIds: favorites,
    recentPaths,
  }), [favorites, favoritesOnly, projects, query, recentOnly, recentPaths]);
  const matches = useMemo(() => sortProjectSwitcherProjects(filteredProjects, order), [filteredProjects, order]);

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    const anchors = resultAnchors(dialog.current);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      anchors[0]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      anchors[anchors.length - 1]?.focus();
    } else if (event.key === "Enter" && anchors[0]) {
      event.preventDefault();
      anchors[0].click();
    }
  };

  const handleResultKeyDown = (event: ReactKeyboardEvent<HTMLAnchorElement>) => {
    if (event.nativeEvent.isComposing) return;
    const anchors = resultAnchors(dialog.current);
    const index = anchors.indexOf(event.currentTarget);
    const next = projectSwitcherResultIndex(event.key, index, anchors.length);
    if (next === null) return;
    event.preventDefault();
    focusResult(dialog.current, next);
  };

  const closeSwitcher = () => setOpen(false);
  const emptyMessage = recentOnly
    ? "最近見たプロジェクトはありません。"
    : favoritesOnly
      ? "お気に入りのプロジェクトはありません。"
      : "一致するプロジェクトがありません。";

  return <>
    <button ref={trigger} className="project-switch-trigger" type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>プロジェクトを切り替え <kbd>Ctrl K</kbd></button>
    <dialog className="project-switch-dialog" ref={dialog} aria-labelledby="project-switch-title" onCancel={(event) => { event.preventDefault(); closeSwitcher(); }} onClick={(event) => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeSwitcher(); } }}>
      <div className="project-switch-heading"><div><span className="eyebrow">QUICK SWITCH</span><h2 id="project-switch-title">プロジェクトを切り替え</h2></div><button className="icon-close" type="button" aria-label="プロジェクトの切り替えを閉じる" onClick={closeSwitcher}>×</button></div>
      <label className="project-switch-search"><span className="sr-only">切り替えるプロジェクトを検索</span><input ref={input} type="search" placeholder="プロジェクト名・パス・リモート" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={handleSearchKeyDown} /></label>
      <div className="project-switch-options" role="group" aria-label="プロジェクトの絞り込みと並び順">
        <button className="project-switch-filter" type="button" aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly((value) => !value)}>{favoritesOnly ? "★ お気に入りのみ" : "☆ お気に入りのみ"}</button>
        <button className="project-switch-filter" type="button" aria-pressed={recentOnly} onClick={() => setRecentOnly((value) => !value)}>最近見たもの <span aria-hidden="true">{recentPaths.length}</span></button>
        <label className="project-switch-sort"><span>並び順</span><select aria-label="切り替え一覧の並び順" value={order} onChange={(event) => setOrder(event.target.value as ProjectSwitcherOrder)}>{PROJECT_SWITCHER_ORDERS.map((value) => <option key={value} value={value}>{value === "recent" ? "最近の活動" : "名前"}</option>)}</select></label>
        <button className="subtle-button project-switch-clear" type="button" disabled={!recentPaths.length && !recentStorageIssue} onClick={clearRecentHistory}>最近見た履歴をクリア</button>
      </div>
      <p className="project-switch-local-note">お気に入りと最近見た履歴は、このブラウザにのみ保存されます。</p>
      {favoritesStorageIssue && <div className="project-switch-storage-issue" role="alert">お気に入りの保存データを読み込めません。ホーム画面で保存を再設定できます。</div>}
      {recentStorageIssue && <div className="project-switch-storage-issue" role="alert">最近見た履歴を保存できないため、この画面では一時的に表示しています。</div>}
      <div className="project-switch-count" role="status">{loading ? "プロジェクトを読み込み中…" : error ? "" : `${matches.length} プロジェクト`}</div>
      {error ? <div className="project-switch-empty" role="alert">プロジェクト一覧を取得できませんでした。<button className="subtle-button" type="button" onClick={() => setReload((value) => value + 1)}>再試行</button></div> : !loading && <div className="project-switch-results">
        {matches.map((project) => project.main_path === null ? <div className="project-switch-unavailable" key={project.id} aria-disabled="true">{project.name}<span>作業パス未取得</span></div> : <Link prefetch={false} href={`/project?path=${encodeURIComponent(project.main_path)}&tab=flow&range=current${homeQuery ? `&home=${encodeURIComponent(homeQuery)}` : ""}`} key={project.id} data-project-switch-result="true" aria-current={project.main_path === currentPath ? "page" : undefined} onClick={() => { rememberRecentPath(project.main_path); closeSwitcher(); }} onKeyDown={handleResultKeyDown}><span><strong>{project.name}</strong><code>{project.main_path}</code></span><span>{project.main_path === currentPath ? "表示中" : "→"}</span></Link>)}
        {matches.length === 0 && <div className="project-switch-empty">{emptyMessage}<button className="subtle-button" type="button" onClick={() => { setQuery(""); input.current?.focus(); }}>検索をクリア</button></div>}
      </div>}
      <div className="project-switch-footer"><span><kbd>↓</kbd> 検索結果へ <kbd>↑</kbd><kbd>↓</kbd><kbd>Home</kbd><kbd>End</kbd> 移動 <kbd>Enter</kbd> 開く</span><span><kbd>Esc</kbd> 閉じる</span></div>
    </dialog>
  </>;
}

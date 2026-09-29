"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ProjectSummary } from "./types";

export default function ProjectSwitcher({ currentPath, homeQuery }: { currentPath: string | null; homeQuery: string | null }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
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
    if (!open) { dialog.current?.close(); return; }
    dialog.current?.showModal();
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
  const normalized = query.trim().toLocaleLowerCase();
  const matches = projects.filter((project) => [project.name, project.main_path, project.remote].some((value) => typeof value === "string" && value.toLocaleLowerCase().includes(normalized)));
  return <>
    <button className="project-switch-trigger" type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>プロジェクトを切り替え <kbd>Ctrl K</kbd></button>
    <dialog className="project-switch-dialog" ref={dialog} aria-labelledby="project-switch-title" onCancel={(event) => { event.preventDefault(); setOpen(false); }} onClick={(event) => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) setOpen(false); } }}>
      <div className="project-switch-heading"><div><span className="eyebrow">QUICK SWITCH</span><h2 id="project-switch-title">プロジェクトを切り替え</h2></div><button className="icon-close" type="button" aria-label="プロジェクトの切り替えを閉じる" onClick={() => setOpen(false)}>×</button></div>
      <label className="project-switch-search"><span className="sr-only">切り替えるプロジェクトを検索</span><input ref={input} type="search" placeholder="プロジェクト名・パス・リモート" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); dialog.current?.querySelector<HTMLAnchorElement>(".project-switch-results a")?.focus(); } }} /></label>
      <div className="project-switch-count" role="status">{loading ? "プロジェクトを読み込み中…" : error ? "" : `${matches.length} プロジェクト`}</div>
      {error ? <div className="project-switch-empty" role="alert">プロジェクト一覧を取得できませんでした。<button className="subtle-button" type="button" onClick={() => setReload((value) => value + 1)}>再試行</button></div> : !loading && <div className="project-switch-results">
        {matches.map((project) => project.main_path === null ? <div className="project-switch-unavailable" key={project.id}>{project.name}<span>作業パス未取得</span></div> : <Link prefetch={false} href={`/project?path=${encodeURIComponent(project.main_path)}&tab=flow&range=current${homeQuery ? `&home=${encodeURIComponent(homeQuery)}` : ""}`} key={project.id} aria-current={project.main_path === currentPath ? "page" : undefined} onClick={() => setOpen(false)}><span><strong>{project.name}</strong><code>{project.main_path}</code></span><span>{project.main_path === currentPath ? "表示中" : "→"}</span></Link>)}
        {matches.length === 0 && <div className="project-switch-empty">一致するプロジェクトがありません。<button className="subtle-button" type="button" onClick={() => { setQuery(""); input.current?.focus(); }}>検索をクリア</button></div>}
      </div>}
      <div className="project-switch-footer"><span><kbd>↓</kbd> 検索結果へ <kbd>Tab</kbd> 移動 <kbd>Enter</kbd> 開く</span><span><kbd>Esc</kbd> 閉じる</span></div>
    </dialog>
  </>;
}

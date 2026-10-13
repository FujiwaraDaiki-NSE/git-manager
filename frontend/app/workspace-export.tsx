"use client";
import { useMemo, useState } from "react";
import CopyButton from "./copy-button";
import { workspaceCsv, workspaceMarkdown, workspaceSnapshot } from "./workspace-snapshot.mjs";
import type { ProjectSummary } from "./types";
import "./workspace-export.css";

export default function WorkspaceExport({ projects, view, disabled }: { projects: ProjectSummary[]; view: object; disabled: boolean }) {
  const [error, setError] = useState(false);
  const markdown = useMemo(() => workspaceMarkdown(projects, view, new Date().toISOString()), [projects, view]);
  const save = (format: "json" | "csv") => {
    setError(false);
    try {
      const now = new Date().toISOString();
      const text = format === "json" ? workspaceSnapshot(projects, view, now) : workspaceCsv(projects, view, now);
      const blob = new Blob([text], { type: format === "json" ? "application/json;charset=utf-8" : "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = `gitdash-projects-${now.slice(0, 10)}.${format}`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setError(true); }
  };
  const unavailable = disabled || projects.length === 0;
  return <fieldset className="workspace-export" disabled={unavailable} aria-label="表示中のプロジェクトを書き出す">
    <button type="button" onClick={() => save("json")} disabled={unavailable} title="表示中のプロジェクトと検索条件をJSONで保存">表示中の一覧をJSON保存</button>
    <button type="button" onClick={() => save("csv")} disabled={unavailable}>表示中の一覧をCSV保存</button>
    <CopyButton value={markdown} label="表示中の一覧をMarkdownでコピー" />
    {error && <span role="alert">ファイルを作成できませんでした。</span>}
  </fieldset>;
}

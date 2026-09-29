"use client";
import { useState } from "react";
import { workspaceSnapshot } from "./workspace-snapshot.mjs";
import type { ProjectSummary } from "./types";

export default function WorkspaceExport({ projects, view, disabled }: { projects: ProjectSummary[]; view: object; disabled: boolean }) {
  const [error, setError] = useState(false);
  const save = () => {
    setError(false);
    try {
      const now = new Date().toISOString();
      const blob = new Blob([workspaceSnapshot(projects, view, now)], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = `gitdash-projects-${now.slice(0, 10)}.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setError(true); }
  };
  return <div className="workspace-export"><button type="button" onClick={save} disabled={disabled || projects.length === 0} title="表示中のプロジェクトと検索条件をJSONで保存">表示中の一覧をJSON保存</button>{error && <span role="alert">ファイルを作成できませんでした。</span>}</div>;
}

"use client";
import { useEffect, useState } from "react";
import CopyButton from "./copy-button";
import type { Repo } from "./types";
import { submoduleCommands, submoduleLabels } from "./submodule-status.mjs";

type Entry = { path: string; recorded_commit: string | null; status: keyof typeof submoduleLabels };

export default function Submodules({ repo }: { repo: Repo }) {
  const path = repo.path;
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/repo/submodules?${new URLSearchParams({ path })}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const data: { submodules: Entry[] } = await response.json();
        if (!controller.signal.aborted) {
          setEntries(data.submodules);
          setError(false);
        }
      }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [path, repo]);
  if (error) return <p role="alert">サブモジュールの状態を取得できませんでした。</p>;
  if (entries === null || entries.length === 0) return null;
  return <section className="status-pane" aria-label="サブモジュール">
    <div className="section-head"><h3>サブモジュール</h3><code className="cmdhint">git submodule status</code></div>
    <p>コマンドは親リポジトリの作業パスで実行してください。記録コミットはindex（次のコミットに含める状態）の値です。</p>
    {entries.map((entry) => <div key={entry.path} className="statusblock">
      <strong><code>{entry.path}</code></strong> <span>{submoduleLabels[entry.status]}</span>
      <p>記録コミット: <code>{entry.recorded_commit === null ? "競合のため未確定" : entry.recorded_commit}</code></p>
      {entry.status === "same" && <p>親リポジトリの記録コミットと一致しています。</p>}
      {submoduleCommands(entry.status, entry.path).map(({ meaning, command }) => <div key={command}>
        <p>{meaning}</p><code>{command}</code> <CopyButton value={command} label={`${entry.path}: ${command} をコピー`} />
      </div>)}
    </div>)}
  </section>;
}

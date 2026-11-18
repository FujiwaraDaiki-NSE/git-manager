"use client";
import { useEffect, useState } from "react";
import CopyButton from "./copy-button";
import type { Repo } from "./types";
import { submoduleCommands, submoduleLabels } from "./submodule-status.mjs";

type Entry = { path: string; recorded_commit: string | null; status: keyof typeof submoduleLabels };

export default function Submodules({ repo }: { repo: Repo }) {
  const path = repo.path;
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [status, setStatus] = useState<"loading" | "success" | "failed">("loading");
  const [retry, setRetry] = useState(0);
  const [resultPath, setResultPath] = useState(path);
  useEffect(() => {
    const controller = new AbortController();
    setStatus("loading");
    if (resultPath !== path) setEntries(null);
    setResultPath(path);
    fetch(`/api/repo/submodules?${new URLSearchParams({ path })}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const data: { submodules: Entry[] } = await response.json();
        if (!controller.signal.aborted) {
          setEntries(data.submodules);
          setStatus("success");
        }
      }).catch(() => { if (!controller.signal.aborted) setStatus("failed"); });
    return () => controller.abort();
  }, [path, repo, retry]);
  const visibleEntries = resultPath === path ? entries : null;
  if (status === "failed") return <div role="alert"><p>サブモジュールの状態を取得できませんでした。</p><button type="button" onClick={() => setRetry(retry + 1)}>再取得</button></div>;
  // 定義なしでは即座に空で返るため、初回取得表示のちらつきを避ける。
  if (visibleEntries === null || visibleEntries.length === 0) return null;
  return <section className="status-pane" aria-label="サブモジュール">
    <div className="section-head"><h3>サブモジュール</h3><code className="cmdhint">git submodule status</code></div>
    {status === "loading" && <p role="status">更新中（前回の結果を表示）</p>}
    <p>コマンドは親リポジトリの作業パスで実行してください。記録コミットはindex（次のコミットに含める状態）の値です。</p>
    {visibleEntries.map((entry) => <div key={entry.path} className="statusblock">
      <strong><code>{entry.path}</code></strong> <span>{submoduleLabels[entry.status]}</span>
      <p>記録コミット: <code>{entry.recorded_commit === null ? "競合のため未確定" : entry.recorded_commit}</code></p>
      {entry.status === "same" && <p>親リポジトリの記録コミットと一致しています。</p>}
      {submoduleCommands(entry.status, entry.path).map(({ meaning, command }) => <div key={command}>
        <p>{meaning}</p><code>{command}</code> <CopyButton value={command} label={`${entry.path}: ${command} をコピー`} />
      </div>)}
    </div>)}
  </section>;
}

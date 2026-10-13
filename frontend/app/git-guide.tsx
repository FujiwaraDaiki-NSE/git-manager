"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import CopyButton from "./copy-button";
import {
  GUIDE_DEFAULT_HISTORY_COUNTS,
  GUIDE_FAVORITES_STORAGE_KEY,
  GUIDE_GROUPS,
  gitGuide,
  guideCommand,
  guideCommandText,
  guideCommands,
  guideDescription,
  guideMarkdown,
  guideMatches,
  parseGuideFavorites,
  validateGuideHistoryCount,
} from "./git-guide-data.mjs";
import "./git-guide.css";

type HistoryKey = "log" | "reflog";
type HistoryCounts = Record<HistoryKey, number>;
type HistoryInputs = Record<HistoryKey, string>;
type HistoryErrors = Record<HistoryKey, string>;
type OperationStatus = "idle" | "working" | "success" | "error";

const historyFields: Array<{ key: HistoryKey; label: string; description: string }> = [
  { key: "log", label: "git log", description: "分岐と合流を見る件数" },
  { key: "reflog", label: "git reflog", description: "HEADの移動履歴の件数" },
];

function selectedSetWith(set: Set<string>, id: string, selected: boolean) {
  const next = new Set(set);
  if (selected) next.add(id);
  else next.delete(id);
  return next;
}

export default function GitGuide({ path }: { path: string | null }) {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("すべて");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [favorites, setFavorites] = useState<Set<string>>(() => new Set());
  const [favoritesReady, setFavoritesReady] = useState(false);
  const [favoritesStorageIssue, setFavoritesStorageIssue] = useState<"read" | "write" | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [historyCounts, setHistoryCounts] = useState<HistoryCounts>({ ...GUIDE_DEFAULT_HISTORY_COUNTS });
  const [historyInputs, setHistoryInputs] = useState<HistoryInputs>({ log: "30", reflog: "20" });
  const [historyErrors, setHistoryErrors] = useState<HistoryErrors>({ log: "", reflog: "" });
  const [copyStatus, setCopyStatus] = useState<OperationStatus>("idle");
  const [downloadStatus, setDownloadStatus] = useState<OperationStatus>("idle");
  const copyRequest = useRef(0);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(GUIDE_FAVORITES_STORAGE_KEY);
      setFavorites(parseGuideFavorites(raw));
    } catch {
      setFavoritesStorageIssue("read");
    } finally {
      setFavoritesReady(true);
    }
  }, []);

  useEffect(() => {
    if (!favoritesReady || favoritesStorageIssue) return;
    try {
      window.localStorage.setItem(GUIDE_FAVORITES_STORAGE_KEY, JSON.stringify([...favorites].sort()));
    } catch {
      setFavoritesStorageIssue("write");
    }
  }, [favorites, favoritesReady, favoritesStorageIssue]);

  const visible = useMemo(() => gitGuide.filter((item) => guideMatches(item, query, group, historyCounts)).filter((item) => !favoriteOnly || favorites.has(item.id)), [favoriteOnly, favorites, group, historyCounts, query]);
  const selectedItems = useMemo(() => gitGuide.filter((item) => selected.has(item.id)), [selected]);
  const selectedCommands = useMemo(() => guideCommands(path, selectedItems, historyCounts), [historyCounts, path, selectedItems]);
  const selectedBatch = selectedCommands.join("\n");
  const visibleSelectedCount = visible.reduce((count, item) => count + (selected.has(item.id) ? 1 : 0), 0);

  useEffect(() => {
    setCopyStatus("idle");
    setDownloadStatus("idle");
  }, [selectedBatch]);

  const toggleFavorite = (id: string) => {
    setFavorites((current) => selectedSetWith(current, id, !current.has(id)));
  };

  const resetFavoriteStorage = () => {
    try {
      window.localStorage.removeItem(GUIDE_FAVORITES_STORAGE_KEY);
      setFavorites(new Set());
      setFavoritesStorageIssue(null);
    } catch {
      setFavoritesStorageIssue("write");
    }
  };

  const applyHistoryCount = (key: HistoryKey) => {
    const result = validateGuideHistoryCount(historyInputs[key]);
    if (!result.valid) {
      setHistoryErrors((current) => ({ ...current, [key]: result.message }));
      return;
    }
    setHistoryCounts((current) => ({ ...current, [key]: result.value }));
    setHistoryInputs((current) => ({ ...current, [key]: String(result.value) }));
    setHistoryErrors((current) => ({ ...current, [key]: "" }));
  };

  const selectVisible = () => {
    setSelected((current) => {
      const next = new Set(current);
      visible.forEach((item) => next.add(item.id));
      return next;
    });
  };

  const clearSelection = () => setSelected(new Set());

  const copySelected = async () => {
    if (!selectedBatch) return;
    const request = ++copyRequest.current;
    setCopyStatus("working");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API is unavailable");
      await navigator.clipboard.writeText(selectedBatch);
      if (copyRequest.current === request) setCopyStatus("success");
    } catch {
      if (copyRequest.current === request) setCopyStatus("error");
    }
  };

  const downloadSelected = () => {
    if (!selectedItems.length) return;
    setDownloadStatus("working");
    try {
      const blob = new Blob([guideMarkdown(selectedItems, path, historyCounts)], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "gitdash-git-cheat-sheet.md";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setDownloadStatus("success");
    } catch {
      setDownloadStatus("error");
    }
  };

  return <details className="command-guide">
    <summary><span>Gitコマンドを調べる</span><span className="command-guide-caption">目的から探して、ターミナルで確認</span></summary>
    <div className="command-guide-body">
      <p>{path === null ? "対象のリポジトリでターミナルを開いて実行してください。" : "コピーするコマンドには、このプロジェクトのパスを含みます。"} ここにあるコマンドは状態確認用です。</p>
      {path !== null && <code className="command-guide-path">{path}</code>}
      {favoritesStorageIssue && <div className="command-guide-storage-error" role="alert"><span>お気に入りをブラウザに保存できません。変更はこの画面にのみ保持されます。</span><button type="button" onClick={resetFavoriteStorage}>保存を再設定</button></div>}
      <div className="command-guide-tools">
        <label>目的・コマンドを検索<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="差分、競合、worktree…" /></label>
        <label>分類<select value={group} onChange={(event) => setGroup(event.target.value)}>{GUIDE_GROUPS.map((value) => <option key={value}>{value}</option>)}</select></label>
        <button className="command-guide-filter" type="button" aria-pressed={favoriteOnly} onClick={() => setFavoriteOnly((current) => !current)}>{favoriteOnly ? "★ お気に入りのみ" : "☆ お気に入りのみ"}</button>
        <span className="command-guide-result-count" role="status" aria-live="polite">{visible.length} 件</span>
      </div>
      <fieldset className="command-guide-history-settings">
        <legend>履歴表示件数</legend>
        <span className="command-guide-history-note">初期値は log 30件・reflog 20件です。入力後に適用した件数を表示・コピー・保存へ反映します。</span>
        <div className="command-guide-history-fields">{historyFields.map((field) => {
          const errorId = `command-guide-${field.key}-error`;
          const pending = historyInputs[field.key] !== String(historyCounts[field.key]);
          return <div className="command-guide-history-field" key={field.key}>
            <label htmlFor={`command-guide-${field.key}`}>{field.description}<span className="command-guide-applied">適用中: {historyCounts[field.key]}件</span></label>
            <div className="command-guide-history-input"><input id={`command-guide-${field.key}`} aria-label={`${field.label}の表示件数`} aria-describedby={errorId} aria-invalid={Boolean(historyErrors[field.key])} inputMode="numeric" min="1" max="500" step="1" type="number" value={historyInputs[field.key]} onChange={(event) => setHistoryInputs((current) => ({ ...current, [field.key]: event.target.value }))} /><button type="button" onClick={() => applyHistoryCount(field.key)}>適用</button></div>
            <span className={historyErrors[field.key] ? "command-guide-history-error" : "command-guide-history-help"} id={errorId} role={historyErrors[field.key] ? "alert" : "status"}>{historyErrors[field.key] || (pending ? "適用するとコマンドへ反映します。" : "1〜500の整数")}</span>
          </div>;
        })}</div>
      </fieldset>
      <div className="command-guide-selection-toolbar" role="group" aria-label="コマンドの選択と出力">
        <span className="command-guide-selection-count" role="status" aria-live="polite">選択中: {selected.size} 件（表示中 {visibleSelectedCount} 件）</span>
        <button type="button" onClick={selectVisible} disabled={!visible.length}>表示中をすべて選択</button>
        <button type="button" onClick={clearSelection} disabled={!selected.size}>選択をすべて解除</button>
        <button type="button" onClick={() => void copySelected()} disabled={!selectedItems.length || copyStatus === "working"}>{copyStatus === "success" ? "選択したコマンドをコピーしました" : "選択したコマンドをコピー"}</button>
        <button type="button" onClick={downloadSelected} disabled={!selectedItems.length || downloadStatus === "working"}>{downloadStatus === "success" ? "Markdownをダウンロードしました" : "選択したコマンドをMarkdownでダウンロード"}</button>
        <span className={`command-guide-operation-status${copyStatus === "error" || downloadStatus === "error" ? " is-error" : ""}`} role={copyStatus === "error" || downloadStatus === "error" ? "alert" : "status"} aria-live="polite">{copyStatus === "error" ? "コマンドをコピーできませんでした。" : downloadStatus === "error" ? "Markdownを保存できませんでした。" : ""}</span>
      </div>
      <div className="command-guide-grid">{visible.map((item) => {
        const command = guideCommand(path, guideCommandText(item, historyCounts));
        return <article key={item.id} className="command-guide-card">
          <div className="command-guide-card-tools"><label className="command-guide-check"><input type="checkbox" checked={selected.has(item.id)} onChange={(event) => setSelected((current) => selectedSetWith(current, item.id, event.target.checked))} />選択</label><button className="command-guide-favorite" type="button" aria-label={favorites.has(item.id) ? `${item.title}のお気に入りを解除` : `${item.title}をお気に入りに追加`} aria-pressed={favorites.has(item.id)} onClick={() => toggleFavorite(item.id)} title={favorites.has(item.id) ? "お気に入りを解除" : "お気に入りに追加"}><span aria-hidden="true">{favorites.has(item.id) ? "★" : "☆"}</span><span className="sr-only">{favorites.has(item.id) ? "お気に入りを解除" : "お気に入りに追加"}</span></button></div>
          <span className="command-guide-group">{item.group}</span><h3>{item.title}</h3><code>{command}</code><p>{guideDescription(item, historyCounts)}</p><CopyButton value={command} label={`${item.title}のコマンドをコピー`} />
        </article>;
      })}</div>
      {visible.length === 0 && <p>{favoriteOnly ? "お気に入りのコマンドがありません。お気に入りのみの絞り込みを解除してください。" : "一致するコマンドがありません。"} <button type="button" onClick={() => { setQuery(""); setGroup("すべて"); setFavoriteOnly(false); }}>条件をリセット</button></p>}
    </div>
  </details>;
}

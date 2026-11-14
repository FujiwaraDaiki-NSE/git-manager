"use client";

import { useEffect, useRef } from "react";

// 各画面のkeydown実装に対応する一覧。通常のTab移動等はブラウザ標準。
const shortcuts = [
  ["Ctrl + K / ⌘ + K", "全画面", "プロジェクト切り替えを開く・閉じる。入力欄からも使えます。"],
  ["/", "ホーム・入力欄の外", "プロジェクト検索欄へ移動。"],
  ["?", "入力欄の外", "このショートカット一覧を開く。"],
  ["Esc", "ダイアログ・プロジェクトの選択詳細", "最前面のダイアログや選択詳細を閉じる。ブランチグラフでは接続の固定も解除。"],
  ["← / → / Home / End", "プロジェクト・Git詳細・ブランチ調査のタブ", "前後・先頭・末尾のタブへ移動して切り替え。"],
  ["↓ / ↑", "プロジェクト切り替えの検索欄", "先頭・末尾の検索結果へ移動。Enterで先頭の結果を開く。"],
  ["↑ / ↓ / Home / End", "プロジェクト切り替えの検索結果", "結果間を移動。Enterで選択したプロジェクトを開く。"],
  ["← / → / ↑ / ↓", "ブランチグラフのコミット点", "同じ行の前後・隣の行の近いコミットへ移動。Enter / Spaceで詳細を開く。"],
  ["↑ / ↓", "ブランチグラフの行・Git詳細のコミットグラフ", "隣の行・コミットへ移動。Git詳細ではEnter / Spaceでコミットを選択。"],
  ["Enter / Shift + Enter", "差分・ファイル本文・競合stageの内容検索欄", "次・前の検索結果へ移動。"],
  ["Enter", "ファイル本文の「行へ移動」欄", "指定した行へ移動。"],
];

export default function ShortcutHelp() {
  const dialog = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const open = (source: HTMLElement | null) => {
    if (!dialog.current || dialog.current.open) return;
    previousFocus.current = source;
    dialog.current.showModal();
  };
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      const target = event.target;
      if (event.key !== "?" || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.defaultPrevented
        || target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select, [role='textbox']"))
        || document.querySelector("dialog[open]")) return;
      event.preventDefault();
      open(document.activeElement instanceof HTMLElement ? document.activeElement : null);
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  return <>
    <button type="button" className="subtle-button shortcut-help-trigger" aria-haspopup="dialog" onClick={(event) => open(event.currentTarget)}>ショートカット <kbd>?</kbd></button>
    <dialog ref={dialog} className="shortcut-help-dialog" aria-labelledby="shortcut-help-title"
      onCancel={(event) => { event.preventDefault(); dialog.current?.close(); }}
      onClose={() => { if (previousFocus.current?.isConnected) previousFocus.current.focus(); }}>
      <div className="shortcut-help-heading"><h2 id="shortcut-help-title">キーボードショートカット</h2><button type="button" className="icon-close" aria-label="ショートカット一覧を閉じる" onClick={() => dialog.current?.close()} autoFocus>×</button></div>
      <p>対象の画面・部品にフォーカスがある場合に使えます。日本語入力の変換中は「?」を無効にしています。</p>
      <table><thead><tr><th scope="col">キー</th><th scope="col">使える場所</th><th scope="col">操作</th></tr></thead><tbody>{shortcuts.map(([keys, scope, action]) => <tr key={`${keys}:${scope}`}><th scope="row"><kbd>{keys}</kbd></th><td>{scope}</td><td>{action}</td></tr>)}</tbody></table>
    </dialog>
  </>;
}

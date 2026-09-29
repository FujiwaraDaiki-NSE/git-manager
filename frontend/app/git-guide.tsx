"use client";

import { useState } from "react";
import CopyButton from "./copy-button";
import { gitGuide, guideCommand, guideMatches } from "./git-guide-data.mjs";
import "./git-guide.css";

export default function GitGuide({ path }: { path: string | null }) {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("すべて");
  const visible = gitGuide.filter((item) => guideMatches(item, query, group));
  return <details className="command-guide">
    <summary><span>Gitコマンドを調べる</span><span className="command-guide-caption">目的から探して、ターミナルで確認</span></summary>
    <div className="command-guide-body">
      <p>{path === null ? "対象のリポジトリでターミナルを開いて実行してください。" : "コピーするコマンドには、このプロジェクトのパスを含みます。"} ここにあるコマンドは状態確認用です。</p>
      {path !== null && <code className="command-guide-path">{path}</code>}
      <div className="command-guide-tools"><label>目的・コマンドを検索<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="差分、競合、worktree…" /></label><label>分類<select value={group} onChange={(event) => setGroup(event.target.value)}>{["すべて", "変更", "履歴", "ブランチ"].map((value) => <option key={value}>{value}</option>)}</select></label><span role="status">{visible.length} 件</span></div>
      <div className="command-guide-grid">{visible.map((item) => <article key={item.id} className="command-guide-card"><span className="command-guide-group">{item.group}</span><h3>{item.title}</h3><code>git {item.command}</code><p>{item.description}</p><CopyButton value={guideCommand(path, item.command)} label={`${item.title}のコマンドをコピー`} /></article>)}</div>
      {visible.length === 0 && <p>一致するコマンドがありません。<button type="button" onClick={() => { setQuery(""); setGroup("すべて"); }}>条件をリセット</button></p>}
    </div>
  </details>;
}

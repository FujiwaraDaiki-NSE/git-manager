"use client";

import { useMemo, useRef, useState } from "react";
import CopyButton from "./copy-button";
import { parsePatch } from "./parse-patch.mjs";

export default function PatchView({ patch }: { patch: string }) {
  const sections = useMemo(() => parsePatch(patch), [patch]);
  const [wrap, setWrap] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = sections.map((section, index) => ({ section, index })).filter(({ section }) => section.title.toLocaleLowerCase().includes(normalizedQuery));
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set([0]));
  if (!sections.length) return <p className="patch-empty">表示できるテキスト差分はありません。マージやバイナリの変更では、テキスト差分がない場合があります。</p>;
  return <section className="patch-view" aria-label="コミットの差分">
    {sections.length > 1 && <div className="patch-search">
      <label>差分ファイルを検索<input ref={searchRef} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ファイル名・パス" /></label>
      <button type="button" disabled={!query} onClick={() => { setQuery(""); searchRef.current?.focus(); }}>クリア</button>
      <span role="status">{visible.length} / {sections.length} ファイル</span>
    </div>}
    <div className="patch-toolbar">
      <span className="patch-legend"><span>＋ 追加</span><span>− 削除</span></span>
      <button type="button" aria-pressed={wrap} onClick={() => setWrap((value) => !value)}>行を折り返す</button>
      {sections.length > 1 && <button type="button" disabled={!visible.length} onClick={() => setExpanded((current) => {
        const collapse = visible.every(({ index }) => current.has(index));
        const next = new Set(current);
        for (const { index } of visible) { if (collapse) next.delete(index); else next.add(index); }
        return next;
      })}>{visible.length > 0 && visible.every(({ index }) => expanded.has(index)) ? "表示中を折りたたむ" : "表示中を展開"}</button>}
      <CopyButton value={patch} label="差分全体をコピー" />
    </div>
    {visible.length === 0 && <p className="patch-empty">一致する差分ファイルがありません。検索語を変更するかクリアしてください。</p>}
    {visible.map(({ section, index }) => <details className="patch-file" key={index} open={expanded.has(index)} onToggle={(event) => {
      const open = event.currentTarget.open;
      setExpanded((current) => {
        if (current.has(index) === open) return current;
        const next = new Set(current);
        if (open) next.add(index); else next.delete(index);
        return next;
      });
    }}>
      <summary title={section.title}><span>{section.title}</span></summary>
      {expanded.has(index) && <div className={`patch-lines${wrap ? " patch-wrap" : ""}`} tabIndex={0} role="region" aria-label={`${section.title} の差分（左: 変更前、右: 変更後の行番号）`}>
        <pre>{section.lines.map((line, row) => <span className={`patch-line patch-${line.kind}`} key={row}><span className="patch-number" aria-hidden="true">{line.oldLine}</span><span className="patch-number" aria-hidden="true">{line.newLine}</span><span className="patch-text">{line.text}{row < section.lines.length - 1 ? "\n" : ""}</span></span>)}</pre>
      </div>}
    </details>)}
  </section>;
}

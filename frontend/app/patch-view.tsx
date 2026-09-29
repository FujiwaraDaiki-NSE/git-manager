"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import CopyButton from "./copy-button";
import { parsePatch } from "./parse-patch.mjs";

const PATCH_PAGE_LINES = 300;

function PatchLines({ section, wrap }: { section: ReturnType<typeof parsePatch>[number]; wrap: boolean }) {
  const [limit, setLimit] = useState(PATCH_PAGE_LINES);
  const containerRef = useRef<HTMLDivElement>(null);
  const focusRow = useRef<number | null>(null);
  const count = Math.min(limit, section.lines.length);
  useLayoutEffect(() => {
    if (focusRow.current === null) return;
    const row = containerRef.current?.querySelector<HTMLElement>(`[data-patch-row="${focusRow.current}"]`);
    focusRow.current = null;
    row?.focus({ preventScroll: true });
    const container = containerRef.current;
    if (row && container) container.scrollTop += row.getBoundingClientRect().top - container.getBoundingClientRect().top;
  }, [limit]);
  const show = (next: number) => {
    focusRow.current = next > limit ? count : 0;
    setLimit(next);
  };
  return <>
    <div ref={containerRef} className={`patch-lines${wrap ? " patch-wrap" : ""}`} tabIndex={0} role="region" aria-label={`${section.title} の差分（左: 変更前、右: 変更後の行番号）`}>
      <pre>{section.lines.slice(0, count).map((line, row) => <span className={`patch-line patch-${line.kind}`} data-patch-row={row} tabIndex={-1} key={row}><span className="patch-number" aria-hidden="true">{line.oldLine}</span><span className="patch-number" aria-hidden="true">{line.newLine}</span><span className="patch-text">{line.text}{row < section.lines.length - 1 ? "\n" : ""}</span></span>)}</pre>
    </div>
    {section.lines.length > PATCH_PAGE_LINES && <div className="patch-more">
      <span role="status">差分 {count.toLocaleString()} / {section.lines.length.toLocaleString()} 行を表示</span>
      {count < section.lines.length ? <>
        <button type="button" onClick={() => show(Math.min(limit + PATCH_PAGE_LINES, section.lines.length))}>次の{Math.min(PATCH_PAGE_LINES, section.lines.length - count)}行を表示</button>
        {section.lines.length - count > PATCH_PAGE_LINES && <button type="button" onClick={() => show(section.lines.length)}>すべての行を表示</button>}
      </> : <button type="button" onClick={() => show(PATCH_PAGE_LINES)}>先頭{PATCH_PAGE_LINES}行のみ表示</button>}
    </div>}
  </>;
}

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
      {expanded.has(index) && <PatchLines section={section} wrap={wrap} />}
    </details>)}
  </section>;
}

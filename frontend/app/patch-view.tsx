"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import CopyButton from "./copy-button";
import { parsePatch } from "./parse-patch.mjs";
import { findPatchMatches, selectPatchRows, splitPatchByFile, summarizePatchSection } from "./patch-tools.mjs";
import "./patch-tools.css";

const PATCH_PAGE_LINES = 300;

type PatchSection = ReturnType<typeof parsePatch>[number];
type PatchMatch = {
  sectionIndex: number;
  lineIndex: number;
  offset: number;
  length: number;
  id: string;
};

function PatchText({ text, matches, activeMatchId }: { text: string; matches: PatchMatch[]; activeMatchId: string | null }) {
  if (matches.length === 0) return <>{text}</>;
  const pieces: React.ReactNode[] = [];
  let cursor = 0;
  matches.forEach((match, index) => {
    if (match.offset > cursor) pieces.push(text.slice(cursor, match.offset));
    pieces.push(<mark className={`patch-match${activeMatchId === match.id ? " patch-match-active" : ""}`} aria-current={activeMatchId === match.id ? "true" : undefined} key={`${match.id}-${index}`}>{text.slice(match.offset, match.offset + match.length)}</mark>);
    cursor = match.offset + match.length;
  });
  if (cursor < text.length) pieces.push(text.slice(cursor));
  return <>{pieces}</>;
}

function PatchLines({ section, wrap, changedOnly, matches, activeMatchId }: { section: PatchSection; wrap: boolean; changedOnly: boolean; matches: PatchMatch[]; activeMatchId: string | null }) {
  const [limit, setLimit] = useState(PATCH_PAGE_LINES);
  const containerRef = useRef<HTMLDivElement>(null);
  const focusRow = useRef<number | null>(null);
  const selectedLines = useMemo(() => selectPatchRows(section.lines, changedOnly), [section.lines, changedOnly]);
  const lineMatches = useMemo(() => {
    const grouped = new Map<number, PatchMatch[]>();
    for (const match of matches) {
      const current = grouped.get(match.lineIndex);
      if (current) current.push(match); else grouped.set(match.lineIndex, [match]);
    }
    return grouped;
  }, [matches]);
  const activeMatch = matches.find((match) => match.id === activeMatchId) ?? null;
  const activePosition = activeMatch === null ? -1 : selectedLines.findIndex(({ lineIndex }) => lineIndex === activeMatch.lineIndex);
  const count = Math.min(limit, selectedLines.length);

  useLayoutEffect(() => {
    if (activePosition >= count) {
      const next = Math.min(Math.ceil((activePosition + 1) / PATCH_PAGE_LINES) * PATCH_PAGE_LINES, selectedLines.length);
      if (next > limit) {
        setLimit(next);
        return;
      }
    }
    const rowIndex = focusRow.current;
    focusRow.current = null;
    const activeRowIndex = activePosition >= 0 && activePosition < count ? activeMatch?.lineIndex ?? null : null;
    if (rowIndex === null && activeRowIndex === null) return;
    const targetRowIndex = rowIndex ?? activeRowIndex;
    const row = containerRef.current?.querySelector<HTMLElement>(`[data-patch-row="${targetRowIndex}"]`);
    const container = containerRef.current;
    if (row && container) {
      row.scrollIntoView({ block: "nearest", inline: "nearest" });
      container.scrollTop += row.getBoundingClientRect().top - container.getBoundingClientRect().top;
      if (rowIndex !== null) row.focus({ preventScroll: true });
    }
  }, [activeMatch, activePosition, count, limit, selectedLines.length]);

  const show = (next: number) => {
    const focusPosition = next > limit ? count : 0;
    const focusLine = selectedLines[focusPosition];
    focusRow.current = focusLine === undefined ? null : focusLine.lineIndex;
    setLimit(next);
  };

  return <>
    <div ref={containerRef} className={`patch-lines${wrap ? " patch-wrap" : ""}${changedOnly ? " patch-lines-changed-only" : ""}`} tabIndex={0} role="region" aria-label={`${section.title} の差分（左: 変更前、右: 変更後の行番号）`}>
      <pre>{selectedLines.slice(0, count).map(({ line, lineIndex }) => {
        const matchesForLine = lineMatches.get(lineIndex) ?? [];
        return <span className={`patch-line patch-${line.kind}${activeMatch?.lineIndex === lineIndex ? " patch-line-active" : ""}`} data-patch-row={lineIndex} tabIndex={-1} key={lineIndex} data-patch-active={activeMatch?.lineIndex === lineIndex ? "true" : undefined}>
          <span className="patch-number" aria-hidden="true">{line.oldLine}</span>
          <span className="patch-number" aria-hidden="true">{line.newLine}</span>
          <span className="patch-text"><PatchText text={line.text} matches={matchesForLine} activeMatchId={activeMatchId} />{lineIndex < section.lines.length - 1 ? "\n" : ""}</span>
        </span>;
      })}</pre>
    </div>
    {selectedLines.length > PATCH_PAGE_LINES && <div className="patch-more">
      <span role="status">{changedOnly ? "変更行" : "差分"} {count.toLocaleString()} / {selectedLines.length.toLocaleString()} 行を表示{changedOnly ? "（コンテキスト行は非表示）" : ""}</span>
      {count < selectedLines.length ? <>
        <button type="button" onClick={() => show(Math.min(limit + PATCH_PAGE_LINES, selectedLines.length))}>次の{Math.min(PATCH_PAGE_LINES, selectedLines.length - count)}行を表示</button>
        {selectedLines.length - count > PATCH_PAGE_LINES && <button type="button" onClick={() => show(selectedLines.length)}>すべての行を表示</button>}
      </> : <button type="button" onClick={() => show(PATCH_PAGE_LINES)}>先頭{PATCH_PAGE_LINES}行のみ表示</button>}
    </div>}
  </>;
}

function FileSummary({ section }: { section: PatchSection }) {
  const summary = summarizePatchSection(section);
  if (summary.binary) return <span className="patch-file-summary patch-file-summary-empty" aria-label="バイナリ差分（テキスト行なし）"><span className="patch-file-stat patch-file-stat-binary">バイナリ</span><span>テキスト行なし</span></span>;
  if (!summary.hasTextLines || (summary.additions === 0 && summary.deletions === 0)) return <span className="patch-file-summary patch-file-summary-empty" aria-label="テキスト差分なし"><span className="patch-file-stat">テキスト差分なし</span></span>;
  return <span className="patch-file-summary" aria-label={`追加 ${summary.additions} 行、削除 ${summary.deletions} 行`}>
    <span className="patch-file-stat patch-file-stat-addition"><strong aria-hidden="true">＋</strong>{summary.additions.toLocaleString()}</span>
    <span className="patch-file-stat patch-file-stat-deletion"><strong aria-hidden="true">−</strong>{summary.deletions.toLocaleString()}</span>
  </span>;
}

export default function PatchView({ patch }: { patch: string }) {
  const sections = useMemo(() => parsePatch(patch), [patch]);
  const sectionPatches = useMemo(() => splitPatchByFile(patch), [patch]);
  const [wrap, setWrap] = useState(false);
  const [changedOnly, setChangedOnly] = useState(false);
  const [fileQuery, setFileQuery] = useState("");
  const [contentQuery, setContentQuery] = useState("");
  const fileSearchRef = useRef<HTMLInputElement>(null);
  const contentSearchRef = useRef<HTMLInputElement>(null);
  const patchResultsId = `patch-results-${useId().replaceAll(":", "")}`;
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set([0]));
  const [activeMatchId, setActiveMatchId] = useState<string | null>(null);

  const normalizedFileQuery = fileQuery.trim().toLocaleLowerCase();
  const visible = useMemo(() => sections.map((section, index) => ({ section, index })).filter(({ section }) => section.title.toLocaleLowerCase().includes(normalizedFileQuery)), [normalizedFileQuery, sections]);
  const visibleIndexes = useMemo(() => visible.map(({ index }) => index), [visible]);
  const matches = useMemo(() => findPatchMatches(sections, contentQuery, { changedOnly, sectionIndexes: visibleIndexes }), [changedOnly, contentQuery, sections, visibleIndexes]);
  const matchesBySection = useMemo(() => {
    const grouped = new Map<number, PatchMatch[]>();
    for (const match of matches) {
      const current = grouped.get(match.sectionIndex);
      if (current) current.push(match); else grouped.set(match.sectionIndex, [match]);
    }
    return grouped;
  }, [matches]);
  const activeMatchIndex = matches.findIndex((match) => match.id === activeMatchId);

  useEffect(() => {
    if (contentQuery.trim() === "" || matches.length === 0) {
      setActiveMatchId(null);
      return;
    }
    setActiveMatchId((current) => matches.some((match) => match.id === current) ? current : matches[0].id);
    setExpanded((current) => {
      const next = new Set(current);
      for (const match of matches) next.add(match.sectionIndex);
      return next;
    });
  }, [contentQuery, matches]);

  useEffect(() => {
    if (sections.length === 0) return;
    setExpanded((current) => current.size > 0 && [...current].every((index) => index < sections.length) ? current : new Set([0]));
  }, [sections]);

  const goToMatch = (direction: 1 | -1) => {
    if (matches.length === 0) return;
    const current = matches.findIndex((match) => match.id === activeMatchId);
    const nextIndex = current < 0 ? (direction === 1 ? 0 : matches.length - 1) : (current + direction + matches.length) % matches.length;
    const next = matches[nextIndex];
    setActiveMatchId(next.id);
    setExpanded((value) => new Set(value).add(next.sectionIndex));
    contentSearchRef.current?.focus();
  };

  if (!sections.length) return <p className="patch-empty">表示できるテキスト差分はありません。マージやバイナリの変更では、テキスト差分がない場合があります。</p>;
  return <section className="patch-view" aria-label="コミットの差分">
    <div className="patch-search">
      {sections.length > 1 && <div className="patch-search-group patch-file-search">
        <label>差分ファイルを検索<input ref={fileSearchRef} type="search" value={fileQuery} onChange={(event) => setFileQuery(event.target.value)} placeholder="ファイル名・パス" /></label>
        <button type="button" disabled={!fileQuery} onClick={() => { setFileQuery(""); fileSearchRef.current?.focus(); }}>クリア</button>
        <span role="status">{visible.length} / {sections.length} ファイル</span>
      </div>}
      <div className="patch-search-group patch-content-search">
        <label>差分の内容を検索<input ref={contentSearchRef} type="search" value={contentQuery} onChange={(event) => setContentQuery(event.target.value)} onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          goToMatch(event.shiftKey ? -1 : 1);
        }} placeholder="追加行・削除行・ヘッダーの内容" aria-controls={patchResultsId} /></label>
        <button type="button" disabled={!contentQuery} onClick={() => { setContentQuery(""); contentSearchRef.current?.focus(); }}>クリア</button>
        <button type="button" aria-label="前の差分検索結果へ" disabled={!matches.length} onClick={() => goToMatch(-1)}>前へ</button>
        <button type="button" aria-label="次の差分検索結果へ" disabled={!matches.length} onClick={() => goToMatch(1)}>次へ</button>
        <span role="status" aria-live="polite">{contentQuery.trim() === "" ? "差分内容を検索" : matches.length === 0 ? "一致する行がありません" : activeMatchIndex < 0 ? `${matches.length} 件の一致候補` : `${activeMatchIndex + 1} / ${matches.length} 件`}</span>
      </div>
    </div>
    <div className="patch-toolbar">
      <span className="patch-legend"><span>＋ 追加</span><span>− 削除</span></span>
      <button type="button" aria-pressed={changedOnly} onClick={() => setChangedOnly((value) => !value)}>{changedOnly ? "すべての行を表示" : "変更行のみ"}</button>
      <button type="button" aria-pressed={wrap} onClick={() => setWrap((value) => !value)}>行を折り返す</button>
      {sections.length > 1 && <button type="button" disabled={!visible.length} onClick={() => setExpanded((current) => {
        const collapse = visible.every(({ index }) => current.has(index));
        const next = new Set(current);
        for (const { index } of visible) { if (collapse) next.delete(index); else next.add(index); }
        return next;
      })}>{visible.length > 0 && visible.every(({ index }) => expanded.has(index)) ? "表示中を折りたたむ" : "表示中を展開"}</button>}
      <CopyButton value={patch} label="差分全体をコピー" />
      {changedOnly && <span className="patch-view-note" role="status">コンテキスト行を非表示中。hunkヘッダーと変更行、行番号は表示しています。</span>}
    </div>
    {visible.length === 0 && <p className="patch-empty">一致する差分ファイルがありません。ファイル名検索を変更するかクリアしてください。</p>}
    <div id={patchResultsId}>
      {visible.map(({ section, index }) => {
        const sectionMatches = matchesBySection.get(index) ?? [];
        const rawSection = sectionPatches[index];
        return <details className="patch-file" key={index} open={expanded.has(index)} onToggle={(event) => {
          const open = event.currentTarget.open;
          setExpanded((current) => {
            if (current.has(index) === open) return current;
            const next = new Set(current);
            if (open) next.add(index); else next.delete(index);
            return next;
          });
        }}>
          <summary title={section.title}>
            <span className="patch-file-title">{section.title}</span>
            <FileSummary section={section} />
            <span className="patch-file-copy" onClick={(event) => { event.preventDefault(); event.stopPropagation(); }} onKeyDown={(event) => event.stopPropagation()}><CopyButton value={rawSection} label={`${section.title} の差分をコピー`} /></span>
          </summary>
          {expanded.has(index) && <PatchLines section={section} wrap={wrap} changedOnly={changedOnly} matches={sectionMatches} activeMatchId={activeMatchId} />}
        </details>;
      })}
    </div>
  </section>;
}

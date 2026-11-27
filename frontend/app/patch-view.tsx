"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { sideBySideRows } from "./side-by-side.mjs";
import CopyButton from "./copy-button";
import { parsePatch } from "./parse-patch.mjs";
import { findPatchMatches, selectPatchRows, splitPatchByFile, summarizePatchSection } from "./patch-tools.mjs";
import {
  buildVisiblePatch,
  filterPatchReviewEntries,
  patchReviewProgress,
  sortPatchReviewEntries,
} from "./patch-review-tools.mjs";
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
type PatchFileKind = "all" | "text" | "binary";
type PatchFileSort = "original" | "path" | "changes";
type PatchSearchLineKind = "all" | "addition" | "deletion";
type PatchReviewEntry = { section: PatchSection; index: number };

const EMPTY_REVIEWED = new Set<number>();

function hunkLabel(text: string) {
  const match = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
  if (match === null) return text;
  const context = match[3].trim();
  return `旧 ${match[1]}行 / 新 ${match[2]}行${context ? ` · ${context}` : ""}`;
}

function scrollToPatchRow(container: HTMLDivElement | null, lineIndex: number, focus: boolean) {
  const row = container?.querySelector<HTMLElement>(`[data-patch-row="${lineIndex}"]`);
  if (!container || !row) return;
  row.scrollIntoView({ block: "nearest", inline: "nearest" });
  container.scrollTop += row.getBoundingClientRect().top - container.getBoundingClientRect().top;
  if (focus) row.focus({ preventScroll: true });
}

function PatchText({ line, matches, activeMatchId, showWhitespace }: { line: PatchSection["lines"][number]; matches: PatchMatch[]; activeMatchId: string | null; showWhitespace: boolean }) {
  const { text, prefixLength } = line;
  const decorate = showWhitespace && prefixLength > 0;
  if (!decorate && matches.length === 0) return <>{text}</>;

  const bodyEnd = text.endsWith("\r") ? text.length - 1 : text.length;
  let trailingStart = bodyEnd;
  if (decorate) {
    while (trailingStart > prefixLength && (text[trailingStart - 1] === " " || text[trailingStart - 1] === "\t")) trailingStart--;
  }
  // Search offsets include the prefix. Decorate only the body inside each raw slice.
  const renderText = (start: number, end: number) => {
    if (!decorate) return text.slice(start, end);
    const pieces: React.ReactNode[] = [];
    let cursor = start;
    for (let index = Math.max(start, prefixLength); index < Math.min(end, bodyEnd); index++) {
      const character = text[index];
      if (character !== "\t" && (character !== " " || index < trailingStart)) continue;
      if (cursor < index) pieces.push(text.slice(cursor, index));
      pieces.push(<span className="patch-whitespace" data-symbol={character === "\t" ? "→" : "·"} key={index}>{character}</span>);
      cursor = index + 1;
    }
    if (cursor < end) pieces.push(text.slice(cursor, end));
    return pieces;
  };

  const pieces: React.ReactNode[] = [];
  let cursor = 0;
  matches.forEach((match, index) => {
    if (match.offset > cursor) pieces.push(renderText(cursor, match.offset));
    pieces.push(<mark className={`patch-match${activeMatchId === match.id ? " patch-match-active" : ""}`} aria-current={activeMatchId === match.id ? "true" : undefined} key={`${match.id}-${index}`}>{renderText(match.offset, match.offset + match.length)}</mark>);
    cursor = match.offset + match.length;
  });
  if (cursor < text.length) pieces.push(renderText(cursor, text.length));
  if (decorate && bodyEnd === prefixLength) {
    pieces.push(<span className="patch-whitespace" data-symbol="∅" aria-hidden="true" key="empty" />);
  }
  return <>{pieces}</>;
}

function PatchLines({ section, wrap, changedOnly, matches, activeMatchId, sideBySide, showWhitespace }: { section: PatchSection; wrap: boolean; changedOnly: boolean; matches: PatchMatch[]; activeMatchId: string | null; sideBySide: boolean; showWhitespace: boolean }) {
  const [limit, setLimit] = useState(PATCH_PAGE_LINES);
  const containerRef = useRef<HTMLDivElement>(null);
  const focusRow = useRef<number | null>(null);
  const selectedLines = useMemo(() => selectPatchRows(section.lines, changedOnly), [section.lines, changedOnly]);
  const hunks = useMemo(() => selectedLines.flatMap(({ line, lineIndex }, position) =>
    line.kind === "hunk" ? [{ label: hunkLabel(line.text), lineIndex, position }] : [],
  ), [selectedLines]);
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
    const targetRowIndex = rowIndex ?? activeRowIndex;
    if (targetRowIndex !== null) scrollToPatchRow(containerRef.current, targetRowIndex, rowIndex !== null);
  }, [activeMatch, activePosition, count, limit, selectedLines.length]);

  const show = (next: number) => {
    const focusPosition = next > limit ? count : 0;
    const focusLine = selectedLines[focusPosition];
    focusRow.current = focusLine === undefined ? null : focusLine.lineIndex;
    setLimit(next);
  };

  return <>
    {hunks.length > 0 && <label className="patch-hunk-index">
      ハンク目次
      <select value="" onChange={(event) => {
        const hunk = hunks.find(({ lineIndex }) => String(lineIndex) === event.target.value);
        if (!hunk) return;
        if (hunk.position < count) {
          scrollToPatchRow(containerRef.current, hunk.lineIndex, true);
        } else {
          focusRow.current = hunk.lineIndex;
          setLimit(Math.ceil((hunk.position + 1) / PATCH_PAGE_LINES) * PATCH_PAGE_LINES);
        }
      }}>
        <option value="" disabled>移動先を選択</option>
        {hunks.map(({ label, lineIndex }, index) => <option key={lineIndex} value={lineIndex}>
          {label.startsWith("@@@") ? label : `${index + 1}. ${label}`}
        </option>)}
      </select>
    </label>}
    <div ref={containerRef} className={`patch-lines${sideBySide ? " patch-lines-side-by-side" : ""}${wrap ? " patch-wrap" : ""}${changedOnly ? " patch-lines-changed-only" : ""}`} tabIndex={0} role="region" aria-label={`${section.title} の差分（左: 変更前、右: 変更後の行番号）`}>
      {sideBySide ? <div className="patch-side-by-side">
        <div className="patch-side-heading"><span>変更前</span><span>変更後</span></div>
        {sideBySideRows(selectedLines.slice(0, count)).map((pair, index) => <div className="patch-side-row" key={index}>
          {pair.shared ? <pre className={`patch-side-shared patch-${pair.shared.line.kind}`} data-patch-row={pair.shared.lineIndex} tabIndex={-1}><PatchText line={pair.shared.line} matches={lineMatches.get(pair.shared.lineIndex) ?? []} activeMatchId={activeMatchId} showWhitespace={showWhitespace} /></pre>
            : [pair.left, pair.right].map((row, side) => <div key={side} className={`patch-side-cell${row ? ` patch-${row.line.kind}` : " patch-side-empty"}${row?.lineIndex === activeMatch?.lineIndex ? " patch-line-active" : ""}`} data-patch-row={row?.lineIndex} tabIndex={-1}>
              <span className="patch-number" aria-hidden="true">{row ? side === 0 ? row.line.oldLine : row.line.newLine : null}</span>
              <pre className="patch-side-text">{row && <PatchText line={row.line} matches={lineMatches.get(row.lineIndex) ?? []} activeMatchId={activeMatchId} showWhitespace={showWhitespace} />}</pre>
            </div>)}
        </div>)}
      </div> : <>      <pre>{selectedLines.slice(0, count).map(({ line, lineIndex }) => {
        const matchesForLine = lineMatches.get(lineIndex) ?? [];
        return <span className={`patch-line patch-${line.kind}${activeMatch?.lineIndex === lineIndex ? " patch-line-active" : ""}`} data-patch-row={lineIndex} tabIndex={-1} key={lineIndex} data-patch-active={activeMatch?.lineIndex === lineIndex ? "true" : undefined}>
          <span className="patch-number" aria-hidden="true">{line.oldLine}</span>
          <span className="patch-number" aria-hidden="true">{line.newLine}</span>
          <span className="patch-text"><PatchText line={line} matches={matchesForLine} activeMatchId={activeMatchId} showWhitespace={showWhitespace} />{lineIndex < section.lines.length - 1 ? "\n" : ""}</span>
        </span>;
      })}</pre></>}

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
  if (summary.hasCombinedHunk) return <span className="patch-file-summary"><span className="patch-file-stat">複数親の差分</span></span>;
  if (!summary.hasTextLines || (summary.additions === 0 && summary.deletions === 0)) return <span className="patch-file-summary patch-file-summary-empty" aria-label="テキスト差分なし"><span className="patch-file-stat">テキスト差分なし</span></span>;
  return <span className="patch-file-summary" aria-label={`追加 ${summary.additions} 行、削除 ${summary.deletions} 行`}>
    <span className="patch-file-stat patch-file-stat-addition"><strong aria-hidden="true">＋</strong>{summary.additions.toLocaleString()}</span>
    <span className="patch-file-stat patch-file-stat-deletion"><strong aria-hidden="true">−</strong>{summary.deletions.toLocaleString()}</span>
  </span>;
}

export default function PatchView({ patch }: { patch: string }) {
  const sections = useMemo(() => parsePatch(patch), [patch]);
  const sectionPatches = useMemo(() => splitPatchByFile(patch), [patch]);
  const indexedSections = useMemo<PatchReviewEntry[]>(() => sections.map((section, index) => ({ section, index })), [sections]);
  const [wrap, setWrap] = useState(false);
  const [showWhitespace, setShowWhitespace] = useState(false);
  const [layout, setLayout] = useState("unified");
  const [wide, setWide] = useState(false);
  useEffect(() => { const media = window.matchMedia("(min-width: 900px)"); const update = () => setWide(media.matches); update(); media.addEventListener("change", update); return () => media.removeEventListener("change", update); }, []);
  const [changedOnly, setChangedOnly] = useState(false);
  const [fileQuery, setFileQuery] = useState("");
  const [fileKind, setFileKind] = useState<PatchFileKind>("all");
  const [fileSort, setFileSort] = useState<PatchFileSort>("original");
  const [hideReviewed, setHideReviewed] = useState(false);
  const [reviewState, setReviewState] = useState<{ patch: string; indexes: Set<number> }>({ patch, indexes: new Set() });
  const [contentQuery, setContentQuery] = useState("");
  const [searchLineKind, setSearchLineKind] = useState<PatchSearchLineKind>("all");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [downloadStatus, setDownloadStatus] = useState("");
  const fileSearchRef = useRef<HTMLInputElement>(null);
  const contentSearchRef = useRef<HTMLInputElement>(null);
  const patchResultsId = `patch-results-${useId().replaceAll(":", "")}`;
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set([0]));
  const [activeMatchId, setActiveMatchId] = useState<string | null>(null);

  const reviewedIndexes = reviewState.patch === patch ? reviewState.indexes : EMPTY_REVIEWED;
  const normalizedFileQuery = fileQuery.trim().toLocaleLowerCase();
  const visible = useMemo(() => {
    const filteredByKind = filterPatchReviewEntries(indexedSections, fileKind);
    const filteredByName = filteredByKind.filter(({ section }) => section.title.toLocaleLowerCase().includes(normalizedFileQuery));
    const filteredByReview = hideReviewed ? filteredByName.filter(({ index }) => !reviewedIndexes.has(index)) : filteredByName;
    return sortPatchReviewEntries(filteredByReview, fileSort);
  }, [fileKind, fileSort, hideReviewed, indexedSections, normalizedFileQuery, reviewedIndexes]);
  const visibleIndexes = useMemo(() => visible.map(({ index }) => index), [visible]);
  const matches = useMemo(() => findPatchMatches(sections, contentQuery, { changedOnly, lineKind: searchLineKind, sectionIndexes: visibleIndexes, caseSensitive, wholeWord }), [changedOnly, searchLineKind, contentQuery, sections, visibleIndexes, caseSensitive, wholeWord]);
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

  useEffect(() => {
    setReviewState({ patch, indexes: new Set() });
    setDownloadStatus("");
  }, [patch]);

  const reviewProgress = useMemo(() => patchReviewProgress(sections.length, reviewedIndexes), [reviewedIndexes, sections.length]);

  const toggleReviewed = (index: number) => {
    setReviewState((current) => {
      const indexes = current.patch === patch ? new Set(current.indexes) : new Set<number>();
      if (indexes.has(index)) indexes.delete(index); else indexes.add(index);
      return { patch, indexes };
    });
  };

  const downloadVisiblePatch = () => {
    const value = buildVisiblePatch(sectionPatches, visible);
    if (value === "") {
      setDownloadStatus("表示中のファイルがありません。");
      return;
    }
    const url = URL.createObjectURL(new Blob([value], { type: "text/x-patch;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "gitdash-visible.patch";
    anchor.click();
    URL.revokeObjectURL(url);
    setDownloadStatus(`${visible.length.toLocaleString()} ファイルのパッチ保存を開始しました。表示順に関係なく元のパッチ順を保持しています。`);
  };

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
          if (event.nativeEvent.isComposing || event.key !== "Enter") return;
          event.preventDefault();
          goToMatch(event.shiftKey ? -1 : 1);
        }} placeholder="追加行・削除行・ヘッダーの内容" aria-controls={patchResultsId} /></label>
        <label className="patch-search-line-kind">検索対象<select value={searchLineKind} onChange={(event) => setSearchLineKind(event.target.value as PatchSearchLineKind)}>
          <option value="all">すべて</option>
          <option value="addition">追加行</option>
          <option value="deletion">削除行</option>
        </select></label>
        <button type="button" disabled={!contentQuery} onClick={() => { setContentQuery(""); contentSearchRef.current?.focus(); }}>クリア</button>
        <button type="button" aria-label="前の差分検索結果へ" disabled={!matches.length} onClick={() => goToMatch(-1)}>前へ</button>
        <button type="button" aria-label="次の差分検索結果へ" disabled={!matches.length} onClick={() => goToMatch(1)}>次へ</button>
        <button type="button" aria-pressed={caseSensitive} onClick={() => setCaseSensitive((value) => !value)}>大文字・小文字を区別</button>
        <button type="button" aria-pressed={wholeWord} title="前後に文字・数字・結合文字・アンダースコア・$がない一致を検索します" onClick={() => setWholeWord((value) => !value)}>単語単位で検索</button>
        <span role="status" aria-live="polite">{contentQuery.trim() === "" ? "差分内容を検索" : matches.length === 0 ? "一致する行がありません" : activeMatchIndex < 0 ? `${matches.length} 件の一致候補` : `${activeMatchIndex + 1} / ${matches.length} 件`}</span>
      </div>
    </div>
    <div className="patch-toolbar">
      <label>差分表示 <select value={wide ? layout : "unified"} disabled={!wide} onChange={e => setLayout(e.target.value)}><option value="unified">unified</option><option value="side-by-side">左右比較</option></select></label>{!wide && <span>狭い画面ではunified表示</span>}
      <span className="patch-legend"><span>＋ 追加</span><span>− 削除</span></span>
      <button type="button" aria-pressed={changedOnly} onClick={() => setChangedOnly((value) => !value)}>{changedOnly ? "すべての行を表示" : "変更行のみ"}</button>
      <button type="button" aria-pressed={wrap} onClick={() => setWrap((value) => !value)}>行を折り返す</button>
      <button type="button" aria-pressed={showWhitespace} title="∅ 空行、→ タブ、· 行末の半角空白" onClick={() => setShowWhitespace((value) => !value)}>空白を可視化</button>
      <details className="patch-advanced"><summary>詳細</summary>      {sections.length > 1 && <div className="patch-review-controls" aria-label="差分ファイルの表示設定">
        <label>内容<select value={fileKind} onChange={(event) => setFileKind(event.target.value as PatchFileKind)}>
          <option value="all">すべて</option>
          <option value="text">テキスト変更</option>
          <option value="binary">バイナリ</option>
        </select></label>
        <label>並び順<select value={fileSort} onChange={(event) => setFileSort(event.target.value as PatchFileSort)}>
          <option value="original">元の順序</option>
          <option value="path">パス順</option>
          <option value="changes">変更行数の多い順</option>
        </select></label>
        <label className="patch-review-checkbox"><input type="checkbox" checked={hideReviewed} onChange={(event) => setHideReviewed(event.target.checked)} />レビュー済みを隠す</label>
      </div>}
      {sections.length > 1 && <button type="button" disabled={!visible.length} onClick={() => setExpanded((current) => {
        const collapse = visible.every(({ index }) => current.has(index));
        const next = new Set(current);
        for (const { index } of visible) { if (collapse) next.delete(index); else next.add(index); }
        return next;
      })}>{visible.length > 0 && visible.every(({ index }) => expanded.has(index)) ? "表示中を折りたたむ" : "表示中を展開"}</button>}
      <CopyButton value={patch} label="差分全体をコピー" />
      <button className="patch-export-button" type="button" disabled={!visible.length} onClick={downloadVisiblePatch}>表示中のファイルをパッチ保存</button>
</details>
      <span className="patch-active-conditions" role="status">内容: {fileKind === "all" ? "すべて" : fileKind === "text" ? "テキスト" : "バイナリ"} · 並び順: {fileSort === "original" ? "元の順序" : fileSort === "path" ? "パス順" : "変更行数順"}{hideReviewed ? " · レビュー済みを非表示" : ""}{changedOnly ? " · 変更行のみ" : ""}</span>
      <span className="patch-review-progress" role="status" aria-live="polite">レビュー済み {reviewProgress.reviewed.toLocaleString()} / {reviewProgress.total.toLocaleString()} ファイル</span>
      {downloadStatus && <span className="patch-download-status" role="status" aria-live="polite">{downloadStatus}</span>}
      <span className="patch-view-note" role="status">レビュー済みの印はこの画面だけの表示状態です。Gitの状態は変更しません。{changedOnly ? " コンテキスト行を非表示中。hunkヘッダーと変更行、行番号は表示しています。" : ""}</span>
    </div>
    {visible.length === 0 && <p className="patch-empty">表示条件に一致する差分ファイルがありません。検索・内容フィルター・レビュー済みを隠す設定を確認してください。</p>}
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
            <button className={`patch-review-toggle${reviewedIndexes.has(index) ? " is-reviewed" : ""}`} type="button" aria-pressed={reviewedIndexes.has(index)} aria-label={`${section.title}を${reviewedIndexes.has(index) ? "未レビューに戻す" : "レビュー済みにする"}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); toggleReviewed(index); }}>
              {reviewedIndexes.has(index) ? "レビュー済み" : "未レビュー"}
            </button>
            <span className="patch-file-copy" onClick={(event) => { event.preventDefault(); event.stopPropagation(); }} onKeyDown={(event) => event.stopPropagation()}><CopyButton value={rawSection} label={`${section.title} の差分をコピー`} /></span>
          </summary>
          {expanded.has(index) && <PatchLines sideBySide={wide && layout === "side-by-side"} section={section} wrap={wrap} changedOnly={changedOnly} matches={sectionMatches} activeMatchId={activeMatchId} showWhitespace={showWhitespace} />}
        </details>;
      })}
    </div>
  </section>;
}

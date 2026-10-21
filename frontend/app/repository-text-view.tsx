"use client";

import { useEffect, useId, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import CopyButton from "./copy-button";
import {
  boundedRepositoryText,
  findRepositoryTextMatches,
  parseRepositoryLineNumber,
  repositoryTextLineAtOffset,
  repositoryTextRange,
  REPOSITORY_TEXT_MAX_PREVIEW_BYTES,
  REPOSITORY_TEXT_PAGE_LINES,
  splitRepositoryText,
  visibleRepositoryWhitespace,
} from "./repository-text-tools.mjs";
import "./repository-text-view.css";

type RepositoryTextLine = ReturnType<typeof splitRepositoryText>[number];
type RepositoryTextMatch = ReturnType<typeof findRepositoryTextMatches>[number] & { id: string; active: boolean };
type RepositoryTextLineMatch = { offset: number; length: number; id: string; active: boolean };

function displayText(value: string, showWhitespace: boolean, keyPrefix: string): ReactNode {
  if (!showWhitespace || (!value.includes(" ") && !value.includes("\t"))) return visibleRepositoryWhitespace(value, showWhitespace);
  const pieces: ReactNode[] = [];
  let plain = "";
  const flush = () => {
    if (plain !== "") {
      pieces.push(plain);
      plain = "";
    }
  };
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === " ") {
      flush();
      pieces.push(<span className="repository-text-space" aria-label="空白" key={`${keyPrefix}-space-${index}`}>·</span>);
    } else if (character === "\t") {
      flush();
      pieces.push(<span className="repository-text-tab" aria-label="タブ" key={`${keyPrefix}-tab-${index}`}>⇥</span>);
    } else {
      plain += character;
    }
  }
  flush();
  return pieces;
}

function lineMatchSegments(line: RepositoryTextLine, matches: RepositoryTextMatch[]): RepositoryTextLineMatch[] {
  return matches.flatMap((match) => {
    const start = Math.max(line.start, match.offset);
    const end = Math.min(line.end, match.end);
    if (start >= end) return [];
    return [{
      offset: start - line.start,
      length: end - start,
      id: match.id,
      active: match.active,
    }];
  });
}

function renderLineContent(
  line: RepositoryTextLine,
  matches: RepositoryTextLineMatch[],
  showWhitespace: boolean,
  activeMarkRef: MutableRefObject<HTMLElement | null>,
) {
  if (matches.length === 0) return displayText(line.text, showWhitespace, `line-${line.number}`);
  const pieces: ReactNode[] = [];
  let cursor = 0;
  matches.forEach((match, index) => {
    if (match.offset > cursor) {
      pieces.push(displayText(line.text.slice(cursor, match.offset), showWhitespace, `line-${line.number}-before-${index}`));
    }
    const value = line.text.slice(match.offset, match.offset + match.length);
    pieces.push(
      <mark
        className={`repository-text-match${match.active ? " is-active" : ""}`}
        aria-current={match.active ? "true" : undefined}
        data-match-id={match.id}
        key={`${match.id}-${line.number}-${index}`}
        ref={match.active ? (node) => { activeMarkRef.current = node; } : undefined}
      >
        {displayText(value, showWhitespace, `line-${line.number}-match-${index}`)}
      </mark>,
    );
    cursor = match.offset + match.length;
  });
  if (cursor < line.text.length) pieces.push(displayText(line.text.slice(cursor), showWhitespace, `line-${line.number}-after`));
  return pieces;
}

export default function RepositoryTextView({ text }: { text: string }) {
  const previewText = useMemo(() => boundedRepositoryText(text, REPOSITORY_TEXT_MAX_PREVIEW_BYTES), [text]);
  const lines = useMemo(() => splitRepositoryText(previewText), [previewText]);
  const [searchQuery, setSearchQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [activeMatchIndex, setActiveMatchIndex] = useState(-1);
  const [showWhitespace, setShowWhitespace] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [lineQuery, setLineQuery] = useState("");
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const [lineLimit, setLineLimit] = useState(REPOSITORY_TEXT_PAGE_LINES);
  const [pendingLine, setPendingLine] = useState<number | null>(null);
  const codeId = `repository-text-code-${useId().replaceAll(":", "")}`;
  const searchRef = useRef<HTMLInputElement>(null);
  const lineRefs = useRef(new Map<number, HTMLDivElement>());
  const activeMarkRef = useRef<HTMLElement | null>(null);

  const matches = useMemo(() => findRepositoryTextMatches(previewText, searchQuery, caseSensitive), [caseSensitive, previewText, searchQuery]);
  const matchesWithIds = useMemo<RepositoryTextMatch[]>(() => matches.map((match, index) => ({ ...match, id: `match-${index}-${match.offset}`, active: index === activeMatchIndex })), [activeMatchIndex, matches]);
  const matchesByLine = useMemo(() => {
    const grouped = new Map<number, RepositoryTextLineMatch[]>();
    for (const match of matchesWithIds) {
      const firstLine = repositoryTextLineAtOffset(lines, match.offset);
      const lastLine = repositoryTextLineAtOffset(lines, Math.max(match.offset, match.end - 1));
      if (firstLine === null || lastLine === null) continue;
      for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber += 1) {
        const line = lines[lineNumber - 1];
        if (!line) continue;
        const segments = lineMatchSegments(line, [match]);
        if (segments.length > 0) {
          const current = grouped.get(lineNumber) ?? [];
          current.push(...segments);
          grouped.set(lineNumber, current);
        }
      }
    }
    return grouped;
  }, [lines, matchesWithIds]);
  const lineNumber = lines.length;
  const visibleLineCount = Math.min(lineLimit, lineNumber);
  const visibleLines = lines.slice(0, visibleLineCount);
  const activeMatch = activeMatchIndex >= 0 ? matches[activeMatchIndex] : undefined;
  const activeMatchLine = activeMatch === undefined ? null : repositoryTextLineAtOffset(lines, activeMatch.offset);
  const goToLineNumber = useMemo(() => parseRepositoryLineNumber(lineQuery, lineNumber), [lineNumber, lineQuery]);
  const range = useMemo(() => repositoryTextRange(previewText, rangeStart, rangeEnd), [previewText, rangeEnd, rangeStart]);
  const resultsId = `${codeId}-results`;

  useEffect(() => {
    setActiveMatchIndex(matches.length > 0 ? 0 : -1);
  }, [matches]);

  useEffect(() => {
    setLineLimit(REPOSITORY_TEXT_PAGE_LINES);
    setLineQuery("");
    setRangeStart("");
    setRangeEnd("");
    setPendingLine(null);
  }, [previewText]);

  useEffect(() => {
    if (activeMatchLine === null) return;
    setLineLimit((current) => Math.max(current, Math.min(lineNumber, Math.ceil(activeMatchLine / REPOSITORY_TEXT_PAGE_LINES) * REPOSITORY_TEXT_PAGE_LINES)));
  }, [activeMatchLine, lineNumber]);

  useEffect(() => {
    if (pendingLine === null) return;
    const row = lineRefs.current.get(pendingLine);
    if (!row) return;
    row.scrollIntoView({ block: "nearest", inline: "nearest" });
    row.focus({ preventScroll: true });
    setPendingLine(null);
  }, [pendingLine, visibleLineCount]);

  useEffect(() => {
    if (pendingLine !== null || activeMatch === undefined) return;
    activeMarkRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeMatch, pendingLine, visibleLineCount]);

  const navigateMatch = (direction: 1 | -1) => {
    if (matches.length === 0) return;
    const next = activeMatchIndex < 0
      ? (direction === 1 ? 0 : matches.length - 1)
      : (activeMatchIndex + direction + matches.length) % matches.length;
    setActiveMatchIndex(next);
    searchRef.current?.focus();
  };

  const navigateLine = () => {
    if (goToLineNumber === null) return;
    setLineLimit((current) => Math.max(current, Math.min(lineNumber, Math.ceil(goToLineNumber / REPOSITORY_TEXT_PAGE_LINES) * REPOSITORY_TEXT_PAGE_LINES)));
    setPendingLine(goToLineNumber);
  };

  if (lines.length === 0) return <section className="repository-text-view" aria-label="バージョン付きファイルのテキスト"><p className="repository-text-empty">表示できる本文はありません。</p></section>;

  return (
    <section className="repository-text-view" aria-label="バージョン付きファイルのテキスト">
      <div className="repository-text-search" role="search" aria-label="本文を検索">
        <label><span>本文検索</span><input ref={searchRef} type="search" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          navigateMatch(event.shiftKey ? -1 : 1);
        }} placeholder="文字列をそのまま検索" aria-controls={resultsId} /></label>
        <button type="button" aria-label="前の本文検索結果へ" disabled={matches.length === 0} onClick={() => navigateMatch(-1)}>前へ</button>
        <button type="button" aria-label="次の本文検索結果へ" disabled={matches.length === 0} onClick={() => navigateMatch(1)}>次へ</button>
        <button type="button" aria-pressed={caseSensitive} onClick={() => setCaseSensitive((value) => !value)}>大文字・小文字を区別</button>
        <span className="repository-text-search-status" role="status" aria-live="polite">{searchQuery === "" ? "本文を検索できます" : matches.length === 0 ? "一致する文字列はありません" : `${activeMatchIndex + 1} / ${matches.length} 件`}</span>
      </div>

      <div className="repository-text-controls" role="toolbar" aria-label="本文の表示とコピー">
        <div className="repository-text-line-jump">
          <label><span>行へ移動</span><input type="text" inputMode="numeric" value={lineQuery} onChange={(event) => setLineQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") navigateLine(); }} placeholder="行番号" aria-label="移動先の行番号" /></label>
          <button type="button" disabled={goToLineNumber === null} onClick={navigateLine}>移動</button>
          <span className="repository-text-control-status" role="status">{lineQuery === "" ? `1〜${lineNumber}行` : goToLineNumber === null ? `1〜${lineNumber}の整数を指定` : `${goToLineNumber}行目へ移動できます`}</span>
        </div>
        <div className="repository-text-range-copy">
          <label><span>開始行</span><input type="text" inputMode="numeric" value={rangeStart} onChange={(event) => setRangeStart(event.target.value)} placeholder="行番号" aria-label="コピー範囲の開始行" /></label>
          <span aria-hidden="true">〜</span>
          <label><span>終了行</span><input type="text" inputMode="numeric" value={rangeEnd} onChange={(event) => setRangeEnd(event.target.value)} placeholder="行番号" aria-label="コピー範囲の終了行" /></label>
          {range ? <CopyButton value={range.text} label={`${range.start}〜${range.end}行目をコピー`} /> : <button type="button" className="copy-button" disabled aria-label="有効な行範囲を指定するとコピーできます">範囲をコピー</button>}
          <span className="repository-text-control-status" role="status">{rangeStart === "" && rangeEnd === "" ? "開始・終了行を指定するとコピーできます" : range === null ? `1〜${lineNumber}の有効な範囲を指定` : `${range.start}〜${range.end}行目をコピーできます`}</span>
        </div>
        <div className="repository-text-display-controls">
          <button type="button" aria-pressed={showWhitespace} onClick={() => setShowWhitespace((value) => !value)}>{showWhitespace ? "空白記号を隠す" : "空白を可視化"}</button>
          <button type="button" aria-pressed={wrap} onClick={() => setWrap((value) => !value)}>{wrap ? "折り返しを解除" : "長い行を折り返す"}</button>
          <CopyButton value={previewText} label="表示中の本文をコピー" />
        </div>
      </div>

      <div id={resultsId} className={`repository-text-code${wrap ? " is-wrapped" : ""}`} role="region" aria-label="行番号付きの本文" tabIndex={0}>
        {visibleLines.map((line) => {
          const matchesForLine = matchesByLine.get(line.number) ?? [];
          return <div
            className="repository-text-line"
            data-line-number={line.number}
            key={line.number}
            ref={(node) => { if (node) lineRefs.current.set(line.number, node); else lineRefs.current.delete(line.number); }}
            tabIndex={-1}
          >
            <span className="repository-text-number" aria-label={`${line.number}行目`}>{line.number}</span>
            <span className="repository-text-content">{renderLineContent(line, matchesForLine, showWhitespace, activeMarkRef)}</span>
          </div>;
        })}
      </div>

      {visibleLineCount < lines.length && <div className="repository-text-pagination">
        <span role="status">{visibleLineCount.toLocaleString()} / {lines.length.toLocaleString()} 行を表示</span>
        <button type="button" onClick={() => setLineLimit((current) => Math.min(lines.length, current + REPOSITORY_TEXT_PAGE_LINES))}>次の{Math.min(REPOSITORY_TEXT_PAGE_LINES, lines.length - visibleLineCount)}行を表示</button>
        <button type="button" onClick={() => setLineLimit(lines.length)}>すべて表示</button>
      </div>}
      {visibleLineCount === lines.length && lines.length > REPOSITORY_TEXT_PAGE_LINES && <div className="repository-text-pagination"><span role="status">全{lines.length.toLocaleString()}行を表示</span><button type="button" onClick={() => setLineLimit(REPOSITORY_TEXT_PAGE_LINES)}>先頭{REPOSITORY_TEXT_PAGE_LINES}行だけ表示</button></div>}
      {previewText !== text && <p className="repository-text-truncated" role="status">表示は先頭64 KiBまでです。表示中の範囲をコピーできます。</p>}
    </section>
  );
}

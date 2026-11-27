"use client";

import { Fragment, useId, useMemo, useState, type ReactNode } from "react";
import { validCommitColumns } from "./ui-preference-tools.mjs";
import { usePreference } from "./ui-preferences";
import ScrollShadow from "./scroll-shadow";
import CopyButton from "./copy-button";
import type { Numstat } from "./types";
import "./commit-files.css";
import {
  COMMIT_FILE_DIRECTORY_ALL,
  COMMIT_FILE_DIRECTORY_ROOT,
  COMMIT_FILE_EXTENSION_ALL,
  COMMIT_FILE_EXTENSION_NONE,
  buildCommitFilesTsv,
  buildCommitFilesPathList,
  buildCommitFileDiffCommand,
  commitFileChangeVolume,
  countCommitFileKinds,
  displayCommitFileCount,
  filterCommitFilesByDirectory,
  filterCommitFilesByExtension,
  filterCommitFiles,
  isBinaryFile,
  isRenamedFile,
  listCommitFileDirectories,
  listCommitFileExtensions,
  commitFileIdentity,
  narrowCommitFiles,
  summarizeCommitFileDirectories,
  sortCommitFiles,
  summarizeCommitFiles,
} from "./commit-file-tools.mjs";

const validColumns = (v: unknown): v is boolean[] => validCommitColumns(v);

type CommitFileFilter = "all" | "text" | "binary" | "renamed" | "unknown";
type CommitFileSort = "path" | "volume" | "additions" | "deletions";
type CommitFileOrder = "asc" | "desc";

type CommitFilesProps = {
  files: Numstat[];
  downloadName: string;
  renderFileSource?: (file: Numstat) => ReactNode;
  fileDiffContext?: { repoPath: string; hash: string };
};

const filters: { id: CommitFileFilter; label: string }[] = [
  { id: "all", label: "すべて" },
  { id: "text", label: "テキスト" },
  { id: "binary", label: "バイナリ" },
  { id: "renamed", label: "名前変更・コピー" },
  { id: "unknown", label: "変更量不明" },
];

const sorts: { id: CommitFileSort; label: string }[] = [
  { id: "path", label: "パス順" },
  { id: "volume", label: "変更量順" },
  { id: "additions", label: "追加行数順" },
  { id: "deletions", label: "削除行数順" },
];

function downloadTsv(files: Numstat[], downloadName: string) {
  const blob = new Blob([buildCommitFilesTsv(files)], { type: "text/tab-separated-values;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = downloadName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function lineLabel(file: Numstat, side: "additions" | "deletions") {
  const label = side === "additions" ? "追加行数" : "削除行数";
  return displayCommitFileCount(file, side) === "不明"
    ? `${label}は不明（バイナリまたはGitが計測していない変更）`
    : `${label} ${displayCommitFileCount(file, side)}`;
}

function directoryLabel(directory: string) {
  return directory === COMMIT_FILE_DIRECTORY_ROOT ? "ルート" : directory;
}

function extensionLabel(extension: string) {
  return extension === COMMIT_FILE_EXTENSION_NONE ? "拡張子なし" : extension;
}

function FilePath({ file }: { file: Numstat }) {
  const hasSourcePath = isRenamedFile(file);
  return (
    <div className="commit-files-paths">
      {hasSourcePath && (
        <span className="commit-files-path commit-files-path-old">
          <span className="commit-files-source-label">変更元パス</span>
          <code title={file.old_path}>{file.old_path}</code>
          <CopyButton value={file.old_path!} label="変更元パスをコピー" />
        </span>
      )}
      {hasSourcePath && <span className="commit-files-arrow" aria-hidden="true">→</span>}
      <span className="commit-files-path">
        <code title={file.path}>{file.path}</code>
        <CopyButton value={file.path} label="パスをコピー" />
      </span>
      {isBinaryFile(file) && <span className="commit-files-binary" title="バイナリの行数は計測できません">バイナリ · 行数不明</span>}
    </div>
  );
}

function FileVolume({ file }: { file: Numstat }) {
  const volume = commitFileChangeVolume(file);
  return volume === null
    ? <span className="commit-files-unknown" title="バイナリまたはGitが計測していないため変更量は不明">不明</span>
    : <span>計{volume.toLocaleString()}行</span>;
}

export default function CommitFiles({ files, downloadName, renderFileSource, fileDiffContext }: CommitFilesProps) {
  const [columns, setColumns] = usePreference("gitdash.commit-file-columns", [true, true, true], validColumns);
  const titleId = `commit-files-title-${useId().replaceAll(":", "")}`;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CommitFileFilter>("all");
  const [directory, setDirectory] = useState<string>(COMMIT_FILE_DIRECTORY_ALL);
  const [extension, setExtension] = useState<string>(COMMIT_FILE_EXTENSION_ALL);
  const [sort, setSort] = useState<CommitFileSort>("path");
  const [order, setOrder] = useState<CommitFileOrder>("asc");
  const [downloadStatus, setDownloadStatus] = useState<"idle" | "success" | "error">("idle");
  const [excluded, setExcluded] = useState("");
  const [scope, setScope] = useState("both");
  const [minimum, setMinimum] = useState("");
  const [change, setChange] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sourceFile, setSourceFile] = useState<string | null>(null);
  const invalidMinimum = minimum !== "" && (!/^\d+$/.test(minimum) || !Number.isSafeInteger(Number(minimum)));
  const searchedFiles = useMemo(
    () => narrowCommitFiles(files, { query, excluded, scope, minimum, change }) as Numstat[],
    [files, query, excluded, scope, minimum, change],
  );
  const directoryOptions = useMemo(() => listCommitFileDirectories(files), [files]);
  const extensionOptions = useMemo(() => listCommitFileExtensions(files), [files]);
  const pathFilteredFiles = useMemo(
    () => filterCommitFilesByExtension(filterCommitFilesByDirectory(searchedFiles, directory), extension),
    [directory, extension, searchedFiles],
  );
  const kindCounts = useMemo(() => ({ ...countCommitFileKinds(pathFilteredFiles), unknown: filterCommitFiles(pathFilteredFiles, "unknown").length }), [pathFilteredFiles]);
  const visibleFiles = useMemo(
    () => sortCommitFiles(filterCommitFiles(pathFilteredFiles, filter), sort, order),
    [filter, order, pathFilteredFiles, sort],
  );
  const summary = useMemo(() => summarizeCommitFiles(visibleFiles), [visibleFiles]);
  const directories = useMemo(
    () => summarizeCommitFileDirectories(filterCommitFiles(filterCommitFilesByExtension(searchedFiles, extension), filter)),
    [searchedFiles, extension, filter],
  );
  const selectedFiles = useMemo(() => files.filter((file) => selected.has(commitFileIdentity(file))), [files, selected]);
  const pageCount = Math.max(1, Math.ceil(visibleFiles.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const start = (currentPage - 1) * pageSize;
  const pageFiles = visibleFiles.slice(start, start + pageSize);
  if (sourceFile !== null && !pageFiles.some((file) => commitFileIdentity(file) === sourceFile)) {
    setSourceFile(null);
  }
  const hasFilters = query !== "" || excluded !== "" || scope !== "both" || minimum !== "" || change !== "all"
    || filter !== "all" || directory !== COMMIT_FILE_DIRECTORY_ALL || extension !== COMMIT_FILE_EXTENSION_ALL;

  const toggleFile = (file: Numstat) => {
    const key = commitFileIdentity(file);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const clearFilters = () => {
    setQuery("");
    setExcluded("");
    setScope("both");
    setMinimum("");
    setChange("all");
    setPage(1);
    setFilter("all");
    setDirectory(COMMIT_FILE_DIRECTORY_ALL);
    setExtension(COMMIT_FILE_EXTENSION_ALL);
  };

  const exportFiles = (rows: Numstat[], name: string) => {
    try {
      downloadTsv(rows, name);
      setDownloadStatus("success");
    } catch {
      setDownloadStatus("error");
    }
  };

  return (
    <section className="commit-files" aria-labelledby={titleId}>
      <div className="commit-files-heading">
        <div>
          <h4 id={titleId}>変更ファイルの一覧</h4>
          <p>絞り込みに一致する全ページのファイルを保存・コピーできます。</p>
        </div>
        <button
          className="commit-files-export"
          type="button"
          onClick={() => exportFiles(visibleFiles, downloadName)}
          disabled={invalidMinimum}
          aria-label={`一致する${visibleFiles.length}ファイルをTSVで保存`}
        >
          ファイル一覧をTSVで保存
        </button>
        <span className={`commit-files-download-status${downloadStatus === "error" ? " is-error" : ""}`} role={downloadStatus === "error" ? "alert" : "status"} aria-live="polite">
          {downloadStatus === "success" ? "TSVの保存を開始しました。" : downloadStatus === "error" ? "TSVを保存できませんでした。" : ""}
        </span>
      </div>

      <div className="commit-files-tools"><div className="commit-files-filters commit-files-columns" role="group" aria-label="表示列"><span>表示列</span>{["追加", "削除", "変更量"].map((label, index) => <button type="button" key={label} aria-pressed={columns[index]} onClick={() => setColumns(columns.map((v, i) => i === index ? !v : v))}>{label}</button>)}</div>
        <label className="commit-files-search">
          <span>変更パスを検索</span>
          <input
            type="search"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setPage(1); }}
            placeholder="現在のパス・変更元パス"
            aria-label="コミットの変更パスを検索"
          />
        </label>
        <label className="commit-files-directory">
          <span>ディレクトリ</span>
          <select
            aria-label="コミットの変更ファイルをディレクトリで絞り込み"
            value={directory}
            onChange={(event) => { setDirectory(event.target.value); setPage(1); }}
          >
            <option value={COMMIT_FILE_DIRECTORY_ALL}>すべて</option>
            {directoryOptions.map((item) => <option key={item} value={item}>{directoryLabel(item)}</option>)}
          </select>
        </label>
        <label className="commit-files-extension">
          <span>拡張子</span>
          <select
            aria-label="コミットの変更ファイルを拡張子で絞り込み"
            aria-describedby={`${titleId}-filter-note`}
            value={extension}
            onChange={(event) => { setExtension(event.target.value); setPage(1); }}
          >
            <option value={COMMIT_FILE_EXTENSION_ALL}>すべて</option>
            {extensionOptions.map((item) => <option key={item} value={item}>{extensionLabel(item)}</option>)}
          </select>
        </label>
        <label className="commit-files-sort">
          <span>並べ替え</span>
          <select aria-label="コミットの変更ファイルを並べ替え" value={sort} onChange={(event) => { setSort(event.target.value as CommitFileSort); setPage(1); }}>
            {sorts.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
        <button
          className="commit-files-order"
          type="button"
          onClick={() => { setOrder((value) => value === "asc" ? "desc" : "asc"); setPage(1); }}
          aria-label={`並べ替えを${order === "asc" ? "降順" : "昇順"}に変更`}
          title={`現在は${order === "asc" ? "昇順" : "降順"}`}
        >
          {order === "asc" ? "昇順 ↑" : "降順 ↓"}
        </button>
        <span className="commit-files-result-count" role="status">{visibleFiles.length} / {files.length} ファイル</span>
        {visibleFiles.length > 0 && (
          <span className="commit-files-copy">
            <CopyButton value={buildCommitFilesPathList(visibleFiles)} label={`一致する${visibleFiles.length}件のパスをコピー`} />
          </span>
        )}
        <p className="commit-files-filter-note" id={`${titleId}-filter-note`}>
          ディレクトリと拡張子は現在のパスと変更元パスを対象にします。拡張子は最後のドット以降を小文字で扱い、<code>.gitignore</code> は「拡張子なし」、<code>.env.local</code> は <code>.local</code> です。
        </p>
      </div>

      <details className="commit-files-extra">
        <summary>パスと行数の詳細条件</summary>
        <div className="commit-files-tools">
          <label><span>除外するパス文字列</span><input type="search" value={excluded} onChange={(event) => { setExcluded(event.target.value); setPage(1); }} /></label>
          <label><span>文字列検索の対象パス</span><select value={scope} onChange={(event) => { setScope(event.target.value); setPage(1); }}>
            <option value="both">現在のパスと変更元パス</option>
            <option value="current">現在のパスのみ</option>
            <option value="previous">変更元パスのみ</option>
          </select></label>
          <label><span>最小変更行数（追加＋削除）</span><input type="text" inputMode="numeric" value={minimum} aria-invalid={invalidMinimum} onChange={(event) => { setMinimum(event.target.value); setPage(1); }} /></label>
          <label><span>行の変更内容</span><select value={change} onChange={(event) => { setChange(event.target.value); setPage(1); }}>
            <option value="all">すべて</option><option value="additions">追加行あり</option><option value="deletions">削除行あり</option>
          </select></label>
          {invalidMinimum && <span role="alert">最小変更行数は0以上の整数を入力してください。</span>}
        </div>
      </details>

      <div className="commit-files-filters" role="group" aria-label="変更ファイルの種類で絞り込み">
        {filters.map((item) => (
          <button
            type="button"
            key={item.id}
            aria-pressed={filter === item.id}
            onClick={() => { setFilter(item.id); setPage(1); }}
          >
            {item.label} {kindCounts[item.id]}
          </button>
        ))}
      </div>

      <div className="commit-files-metrics" aria-label="表示中の変更ファイル集計">
        <div><span>ファイル</span><strong>{summary.files}</strong></div>
        <div><span>追加行（既知）</span><strong>+{summary.additions}</strong>{summary.unknownAdditions && <small>不明を含む</small>}</div>
        <div><span>削除行（既知）</span><strong>−{summary.deletions}</strong>{summary.unknownDeletions && <small>不明を含む</small>}</div>
        <div><span>バイナリ</span><strong>{summary.binary}</strong>{summary.binary > 0 && <small>行数不明</small>}</div>
      </div>

      {directories.length > 0 && (
        <details className="commit-files-extra">
          <summary>ディレクトリ別の変更集計</summary>
          <p>ディレクトリ条件を外した集計です。名前変更・コピーは変更元パスと現在のパスの両方を対象にします。</p>
          <ul>{directories.map((item) => <li key={item.directory}>
            <button className="subtle-button" type="button" onClick={() => { setDirectory(item.directory); setPage(1); }}>{directoryLabel(item.directory)}</button>
            <span>{item.files} 件 · 既知の追加 +{item.additions} / 削除 −{item.deletions}{(item.unknownAdditions || item.unknownDeletions) && " · 不明を含む"}</span>
          </li>)}</ul>
        </details>
      )}
      <div className="commit-files-tools commit-files-selection">
        <span role="status">{selectedFiles.length} 件選択中</span>
        <button className="subtle-button" type="button" disabled={selectedFiles.length === 0} onClick={() => exportFiles(selectedFiles, downloadName.replace(/\.tsv$/u, "-selected.tsv"))}>選択したファイルをTSVで保存</button>
        <button className="subtle-button" type="button" disabled={selectedFiles.length === 0} onClick={() => setSelected(new Set())}>選択を解除</button>
        {hasFilters && <button className="subtle-button" type="button" onClick={clearFilters}>絞り込みを解除</button>}
      </div>
      {visibleFiles.length === 0 ? (
        <div className="commit-files-empty" role="status">
          {files.length === 0 ? "変更ファイルはありません。" : "条件に一致する変更ファイルはありません。"}
        </div>
      ) : (
        <ScrollShadow className="commit-files-table-wrap" label="横スクロールできる表">
          <table className="commit-files-table">
            <caption className="sr-only">コミットで変更されたファイル</caption>
            <thead><tr><th scope="col">選択</th>{columns[0] && <th scope="col">追加</th>}{columns[1] && <th scope="col">削除</th>}{columns[2] && <th scope="col">変更量（追加＋削除）</th>}<th scope="col">パス</th></tr></thead>
            <tbody>
              {pageFiles.map((file) => {
                const identity = commitFileIdentity(file);
                const sourceOpen = sourceFile === identity;
                const diffCommand = fileDiffContext ? buildCommitFileDiffCommand(fileDiffContext.repoPath, fileDiffContext.hash, file) : null;
                return <Fragment key={identity}>
                  <tr>
                    <td><input type="checkbox" aria-label={`${file.path} を選択`} checked={selected.has(identity)} onChange={() => toggleFile(file)} /></td>
                    {columns[0] && <td className="additions" aria-label={lineLabel(file, "additions")}>{displayCommitFileCount(file, "additions") === "不明" ? <span className="commit-files-unknown">不明</span> : `+${displayCommitFileCount(file, "additions")}`}</td>}
                    {columns[1] && <td className="deletions" aria-label={lineLabel(file, "deletions")}>{displayCommitFileCount(file, "deletions") === "不明" ? <span className="commit-files-unknown">不明</span> : `−${displayCommitFileCount(file, "deletions")}`}</td>}
                    {columns[2] && <td className="commit-files-volume"><FileVolume file={file} /></td>}
                    <td>
                      <FilePath file={file} />
                      {diffCommand !== null && <CopyButton value={diffCommand} label="差分コマンドをコピー" />}
                      {renderFileSource && <button className="subtle-button commit-files-source-button" type="button" aria-expanded={sourceOpen} aria-label={`${file.path} の両版の原文`} onClick={() => setSourceFile(sourceOpen ? null : identity)}>両版の原文</button>}
                    </td>
                  </tr>
                  {renderFileSource && sourceOpen && <tr><td className="commit-files-source-cell" colSpan={2 + columns.filter(Boolean).length}>{renderFileSource(file)}</td></tr>}
                </Fragment>;
              })}
            </tbody>
          </table>
        </ScrollShadow>
      )}
      {files.length > 25 && visibleFiles.length > 0 && <nav className="commit-files-tools" aria-label="変更ファイル一覧のページ">
        <label><span>1ページのファイル数</span><select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}>
          <option value={25}>25</option><option value={50}>50</option><option value={100}>100</option>
        </select></label>
        <button className="subtle-button" type="button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>前のページ</button>
        <span role="status">{start + 1}–{start + pageFiles.length} / {visibleFiles.length} 件</span>
        <button className="subtle-button" type="button" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>次のページ</button>
      </nav>}
      {summary.binary > 0 && <p className="commit-files-note" role="note">バイナリの追加・削除行数はGitのnumstatで計測できないため、集計には含めず「不明」と表示しています。</p>}
    </section>
  );
}

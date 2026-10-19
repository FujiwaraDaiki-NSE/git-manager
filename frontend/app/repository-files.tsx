"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  REPOSITORY_FILES_MAX_BLOB_BYTES,
  REPOSITORY_FILES_MAX_PREVIEW_BYTES,
  boundedRepositoryText,
  buildRepositoryFileHistoryHref,
  filterRepositoryFileEntries,
  listRepositoryDirectoryEntries,
  repositoryBase64ToBytes,
  repositoryFileName,
  repositoryFileQuery,
  repositoryFilesQuery,
} from "./repository-files-tools.mjs";
import "./repository-files.css";

type RepositoryFileEntry = {
  path: string;
  mode: string;
  type: string;
  hash: string | null;
};

type RepositoryFilesInventory = {
  revision: string;
  pinned_hash: string;
  entries: RepositoryFileEntry[];
  truncated: boolean;
  limit: number;
};

type RepositoryFilePayload = {
  revision: string;
  pinned_hash: string;
  path: string;
  hash: string;
  mode: string;
  type: string;
  kind: "blob" | "symlink" | "gitlink";
  size: number;
  binary: boolean;
  text: string | null;
  content_base64: string;
  truncated: boolean;
  downloadable: boolean;
  download_limit: number;
};

type LoadState = "idle" | "loading" | "ready" | "error";

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isInventory(value: unknown): value is RepositoryFilesInventory {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<RepositoryFilesInventory>;
  return isString(item.revision)
    && isString(item.pinned_hash)
    && Array.isArray(item.entries)
    && typeof item.truncated === "boolean"
    && Number.isInteger(item.limit)
    && item.entries.every((entry) => entry && typeof entry === "object" && isString(entry.path) && isString(entry.mode) && isString(entry.type));
}

function isFilePayload(value: unknown): value is RepositoryFilePayload {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<RepositoryFilePayload>;
  return isString(item.revision)
    && isString(item.pinned_hash)
    && isString(item.path)
    && isString(item.hash)
    && isString(item.mode)
    && isString(item.type)
    && (item.kind === "blob" || item.kind === "symlink" || item.kind === "gitlink")
    && Number.isInteger(item.size)
    && typeof item.binary === "boolean"
    && (item.text === null || isString(item.text))
    && isString(item.content_base64)
    && typeof item.truncated === "boolean"
    && typeof item.downloadable === "boolean"
    && Number.isInteger(item.download_limit);
}

async function responseError(response: Response) {
  try {
    const body = await response.json() as { detail?: unknown };
    if (typeof body.detail === "string" && body.detail) return body.detail;
  } catch {
    // The status remains useful when a proxy responds with non-JSON text.
  }
  return `HTTP ${response.status}`;
}

function shortHash(value: string) {
  return value.slice(0, 12);
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value < 0) return "サイズ未取得";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
}

function entryKind(entry: RepositoryFileEntry) {
  if (entry.type === "tree") return "ディレクトリ";
  if (entry.type === "commit" || entry.mode === "160000") return "gitlink";
  if (entry.mode === "120000") return "symlink";
  return entry.type;
}

function directoryLabel(directory: string) {
  return directory || "ルート";
}

function breadcrumbParts(directory: string) {
  if (!directory) return [];
  return directory.split("/").map((name, index, parts) => ({ name, path: parts.slice(0, index + 1).join("/") }));
}

function fullHash(value: string) {
  return /^[0-9a-f]{40,64}$/iu.test(value);
}

export default function RepositoryFiles({ path }: { path: string }) {
  const [revision, setRevision] = useState("");
  const [directory, setDirectory] = useState("");
  const [query, setQuery] = useState("");
  const [inventory, setInventory] = useState<RepositoryFilesInventory | null>(null);
  const [inventoryState, setInventoryState] = useState<LoadState>("idle");
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [file, setFile] = useState<RepositoryFilePayload | null>(null);
  const [fileState, setFileState] = useState<LoadState>("idle");
  const [fileError, setFileError] = useState<string | null>(null);
  const [downloadStatus, setDownloadStatus] = useState("");
  const [open, setOpen] = useState(false);
  const inventoryControllerRef = useRef<AbortController | null>(null);
  const fileControllerRef = useRef<AbortController | null>(null);
  const inventoryKeyRef = useRef<string | null>(null);
  const fileKeyRef = useRef<string | null>(null);

  useEffect(() => {
    inventoryControllerRef.current?.abort();
    fileControllerRef.current?.abort();
    inventoryControllerRef.current = null;
    fileControllerRef.current = null;
    inventoryKeyRef.current = null;
    fileKeyRef.current = null;
    setRevision("");
    setDirectory("");
    setQuery("");
    setInventory(null);
    setInventoryState("idle");
    setInventoryError(null);
    setSelectedFile(null);
    setFile(null);
    setFileState("idle");
    setFileError(null);
    setDownloadStatus("");
    setOpen(false);
  }, [path]);

  useEffect(() => {
    inventoryControllerRef.current?.abort();
    fileControllerRef.current?.abort();
    inventoryControllerRef.current = null;
    fileControllerRef.current = null;
    inventoryKeyRef.current = null;
    fileKeyRef.current = null;
    setInventory(null);
    setInventoryState("idle");
    setInventoryError(null);
    setDirectory("");
    setQuery("");
    setSelectedFile(null);
    setFile(null);
    setFileState("idle");
    setFileError(null);
    setDownloadStatus("");
  }, [revision]);

  const visibleEntries = useMemo(() => {
    if (!inventory) return [];
    return filterRepositoryFileEntries(inventory.entries, directory, query);
  }, [directory, inventory, query]);

  const breadcrumbs = useMemo(() => breadcrumbParts(directory), [directory]);
  const searching = query.trim() !== "";

  const loadInventory = () => {
    if (!revision) {
      setInventoryError("revision を指定してください。");
      setInventoryState("error");
      return;
    }
    inventoryControllerRef.current?.abort();
    fileControllerRef.current?.abort();
    const controller = new AbortController();
    const requestKey = JSON.stringify([path, revision]);
    inventoryControllerRef.current = controller;
    inventoryKeyRef.current = requestKey;
    setInventoryState("loading");
    setInventoryError(null);
    setInventory(null);
    setDirectory("");
    setQuery("");
    setSelectedFile(null);
    setFile(null);
    setFileState("idle");
    setFileError(null);
    setDownloadStatus("");
    setOpen(true);
    const params = repositoryFilesQuery(path, revision, "", "");
    void fetch(`/api/repo/files?${params}`, { cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(await responseError(response));
      const value: unknown = await response.json();
      if (!isInventory(value)) throw new Error("ファイル一覧の応答形式が不正です。");
      return value;
    }).then((value) => {
      if (controller.signal.aborted || inventoryKeyRef.current !== requestKey) return;
      setInventory(value);
      setInventoryState("ready");
    }).catch((caught: unknown) => {
      if (controller.signal.aborted || inventoryKeyRef.current !== requestKey) return;
      setInventoryError(caught instanceof Error ? caught.message : "ファイル一覧を取得できませんでした。");
      setInventoryState("error");
    }).finally(() => {
      if (inventoryControllerRef.current === controller && inventoryKeyRef.current === requestKey) inventoryControllerRef.current = null;
    });
  };

  const loadFile = (entry: RepositoryFileEntry) => {
    if (entry.type === "tree") {
      fileControllerRef.current?.abort();
      fileControllerRef.current = null;
      fileKeyRef.current = null;
      setDirectory(entry.path);
      setQuery("");
      setSelectedFile(null);
      setFile(null);
      setFileState("idle");
      setFileError(null);
      return;
    }
    if (!inventory) return;
    fileControllerRef.current?.abort();
    const controller = new AbortController();
    const requestKey = JSON.stringify([path, inventory.pinned_hash, entry.path]);
    fileControllerRef.current = controller;
    fileKeyRef.current = requestKey;
    setSelectedFile(entry.path);
    setFileState("loading");
    setFileError(null);
    setFile(null);
    setDownloadStatus("");
    const params = repositoryFileQuery(path, inventory.pinned_hash, entry.path);
    void fetch(`/api/repo/file?${params}`, { cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(await responseError(response));
      const value: unknown = await response.json();
      if (!isFilePayload(value)) throw new Error("ファイル内容の応答形式が不正です。");
      return value;
    }).then((value) => {
      if (controller.signal.aborted || fileKeyRef.current !== requestKey) return;
      setFile(value);
      setFileState("ready");
    }).catch((caught: unknown) => {
      if (controller.signal.aborted || fileKeyRef.current !== requestKey) return;
      setFileError(caught instanceof Error ? caught.message : "ファイルを取得できませんでした。");
      setFileState("error");
    }).finally(() => {
      if (fileControllerRef.current === controller && fileKeyRef.current === requestKey) fileControllerRef.current = null;
    });
  };

  const download = () => {
    if (!file || file.downloadable !== true || file.truncated || file.size > REPOSITORY_FILES_MAX_BLOB_BYTES) return;
    try {
      const bytes = repositoryBase64ToBytes(file.content_base64);
      // A partial or malformed response must never be offered as a complete
      // download, even if a server accidentally marks it downloadable.
      if (bytes.byteLength !== file.size) {
        setDownloadStatus("完全なblobを取得できないため保存できません。");
        return;
      }
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = repositoryFileName(file.path);
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDownloadStatus("完全なblobを保存しました。");
    } catch {
      setDownloadStatus("blobを保存できませんでした。");
    }
  };

  let historyHref: string | null = null;
  if (typeof window !== "undefined" && file && fullHash(file.pinned_hash) && file.kind !== "gitlink") {
    try {
      historyHref = buildRepositoryFileHistoryHref(window.location.href, path, file.pinned_hash, file.path, true);
    } catch {
      historyHref = null;
    }
  }
  const previewText = file?.text === null || file?.text === undefined ? null : boundedRepositoryText(file.text, REPOSITORY_FILES_MAX_PREVIEW_BYTES);
  const binaryPreview = file?.binary && file.content_base64 ? file.content_base64.slice(0, Math.floor(REPOSITORY_FILES_MAX_PREVIEW_BYTES / 3) * 4) : "";
  const canDownload = file?.downloadable === true && file.truncated === false && file.size <= REPOSITORY_FILES_MAX_BLOB_BYTES;

  return (
    <details className="repository-files" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary id="repository-files-title">版を指定してファイルを調べる <span>固定revision・ディレクトリ・バイナリ保存</span></summary>
      <div className="repository-files-body">
        <div className="repository-files-heading">
          <div>
            <h3>Gitの版に含まれるファイルを確認</h3>
            <p>ブランチ名やHEADを入力すると、その時点のGitオブジェクトだけを読み取ります。作業中のファイルは参照しません。</p>
          </div>
          <code className="repository-files-repo" title={path}>{path}</code>
        </div>

        <div className="repository-files-inputs" role="group" aria-label="revision file browserの対象">
          <label><span>revision（必須）</span><input type="text" value={revision} onChange={(event) => setRevision(event.target.value)} placeholder="HEAD、ブランチ名、完全ハッシュ" aria-label="revision" /></label>
          <button type="button" className="primary-action" disabled={!revision || inventoryState === "loading"} onClick={loadInventory}>{inventoryState === "loading" ? "ファイル一覧を取得中…" : "版のファイルを取得"}</button>
        </div>

        {inventoryState === "error" && <p className="repository-files-error" role="alert">ファイル一覧を取得できませんでした。{inventoryError && <span>（{inventoryError}）</span>}</p>}
        {inventoryState === "idle" && <p className="repository-files-empty" role="status">revisionを指定してファイル一覧を取得してください。</p>}

        {inventory && (
          <section className="repository-files-inventory" aria-labelledby="repository-files-inventory-title">
            <div className="repository-files-inventory-heading">
              <div><h4 id="repository-files-inventory-title">取得済みのファイル一覧</h4><p><code>{shortHash(inventory.pinned_hash)}</code> に固定 · {inventory.entries.length.toLocaleString()}件</p></div>
              <span className="repository-files-count" role="status">{searching ? "取得済み全パスを検索" : `${directoryLabel(directory)}を表示`}</span>
            </div>
            <div className="repository-files-tools" role="group" aria-label="取得済みファイルの検索と移動">
              <label><span>ファイルパス検索</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="取得済みの全パスを検索" aria-label="取得済みrevisionのファイルパスを検索" /></label>
              <div className="repository-files-breadcrumbs" aria-label="ディレクトリ階層"><button type="button" className={directory === "" ? "is-current" : ""} onClick={() => { setDirectory(""); setQuery(""); }}>ルート</button>{breadcrumbs.map((crumb) => <span key={crumb.path}><span aria-hidden="true">/</span><button type="button" className={directory === crumb.path ? "is-current" : ""} onClick={() => { setDirectory(crumb.path); setQuery(""); }}>{crumb.name}</button></span>)}</div>
            </div>
            {inventory.truncated && <p className="repository-files-truncated" role="status">ファイル一覧は{inventory.limit.toLocaleString()}件で切り詰められています。検索対象も取得済みのパスに限られます。</p>}
            {visibleEntries.length === 0 ? <p className="repository-files-empty" role="status">{searching ? "検索に一致する取得済みパスはありません。" : "このディレクトリにファイルはありません。"}</p> : <div className="repository-files-table-wrap" role="region" aria-label="revisionのファイル一覧" tabIndex={0}><table className="repository-files-table"><thead><tr><th>種別</th><th>パス</th><th>object</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{visibleEntries.map((entry) => <tr key={`${entry.type}:${entry.path}`}><td><span className={`repository-files-kind repository-files-kind-${entry.type === "tree" ? "tree" : "file"}`}>{entryKind(entry)}</span></td><td className="repository-files-path"><code title={entry.path}>{entry.path}</code></td><td>{entry.hash ? <code title={entry.hash}>{shortHash(entry.hash)}</code> : "—"}</td><td><button type="button" className="table-action" onClick={() => loadFile(entry)}>{entry.type === "tree" ? "開く" : "表示"}</button></td></tr>)}</tbody></table></div>}
          </section>
        )}

        {selectedFile && fileState === "loading" && <p className="repository-files-status" role="status">{selectedFile} を取得中…</p>}
        {fileState === "error" && <p className="repository-files-error" role="alert">ファイルを取得できませんでした。{fileError && <span>（{fileError}）</span>}</p>}
        {file && fileState === "ready" && (
          <section className="repository-files-viewer" aria-labelledby="repository-files-viewer-title">
            <div className="repository-files-viewer-heading">
              <div><h4 id="repository-files-viewer-title">{file.path}</h4><p><span>{entryKind({ path: file.path, mode: file.mode, type: file.type, hash: file.hash })}</span> · {formatBytes(file.size)} · <code>{shortHash(file.hash)}</code></p></div>
              <div className="repository-files-actions">
                {historyHref && <a className="subtle-button" href={historyHref}>ファイル履歴を調べる</a>}
                <button type="button" className="subtle-button" disabled={!canDownload} onClick={download}>完全なblobを保存</button>
              </div>
            </div>
            {file.kind === "symlink" && <p className="repository-files-note" role="note">symlinkのリンク先は追跡しません。Gitに保存されたリンク文字列だけを表示しています。</p>}
            {file.kind === "gitlink" && <p className="repository-files-note" role="note">gitlinkはサブモジュールの参照です。別リポジトリの内容は読み取りません。</p>}
            {file.binary ? <div className="repository-files-binary" role="status"><strong>バイナリblob</strong><p>UTF-8テキストとして表示できないため、保存可能な完全blobかどうかだけを明示します。</p>{binaryPreview && <pre aria-label="バイナリblobのbase64プレビュー">{binaryPreview}</pre>}</div> : file.text !== null && file.text !== undefined ? <pre className="repository-files-text" aria-label="バージョン付きファイルのテキスト">{previewText}</pre> : <p className="repository-files-empty" role="status">表示できる本文はありません。</p>}
            {file.truncated && <p className="repository-files-truncated" role="status">blobが{formatBytes(file.download_limit)}を超えるため、先頭のプレビューだけを表示しています。完全な保存はできません。</p>}
            {!file.truncated && !canDownload && file.kind !== "gitlink" && <p className="repository-files-note" role="status">このblobはダウンロード対象外です。</p>}
            {downloadStatus && <p className="repository-files-status" role="status" aria-live="polite">{downloadStatus}</p>}
          </section>
        )}
      </div>
    </details>
  );
}

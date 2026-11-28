"use client";

import { useEffect, useState } from "react";
import { repositoryFileQuery } from "./repository-files-tools.mjs";

type FileSourceContent = { binary: boolean; text: string | null; truncated: boolean };
type FileSource =
  | { state: "loading" | "missing" }
  | { state: "error"; message: string }
  | { state: "ready"; content: FileSourceContent };

async function fetchFileSource(path: string, revision: string, file: string, signal: AbortSignal): Promise<FileSource> {
  const params = repositoryFileQuery(path, revision, file);
  const response = await fetch(`/api/repo/file-text?${params}`, { cache: "no-store", signal });
  if (response.status === 404) {
    // A missing repository can also return 404. Only these file results mean the side is absent.
    const body = await response.json().catch(() => null);
    if (body?.detail === "指定したrevisionにファイルがありません" || body?.detail === "指定したパスはファイルではありません") {
      return { state: "missing" };
    }
  }
  if (!response.ok) return { state: "error", message: `原文を取得できませんでした（HTTP ${response.status}）。` };
  const content = await response.json();
  if (content?.path !== file || content.pinned_hash !== revision || typeof content.truncated !== "boolean"
    || typeof content.binary !== "boolean" || (content.binary ? content.text !== null : typeof content.text !== "string")) {
    return { state: "error", message: "原文の応答を確認できませんでした。" };
  }
  return { state: "ready", content };
}

export default function RepositoryFileSource({ label, path, revision, file }: { label: string; path: string; revision: string; file: string }) {
  const [source, setSource] = useState<FileSource>({ state: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    void fetchFileSource(path, revision, file, controller.signal).then((result) => {
      if (!controller.signal.aborted) setSource(result);
    }).catch(() => {
      if (!controller.signal.aborted) setSource({ state: "error", message: "原文を取得できませんでした。" });
    });
    return () => controller.abort();
  }, [path, revision, file]);

  return <section aria-label={`${label}の原文`}>
    <h5>{label}</h5>
    <p><code>{file}</code><br /><code>{revision}</code></p>
    {source.state === "loading" && <p role="status">原文を取得中…</p>}
    {source.state === "missing" && <p role="status">この版にファイルはありません。</p>}
    {source.state === "error" && <p role="alert">{source.message}</p>}
    {source.state === "ready" && <>
      {source.content.truncated && <p role="status">原文は取得上限で省略されています。</p>}
      {source.content.binary ? <p>バイナリのためテキスト表示できません。</p>
        : source.content.text === "" ? <p>空のファイルです。</p>
        : <pre tabIndex={0} role="region" aria-label={`${label}のテキスト`}>{source.content.text}</pre>}
    </>}
  </section>;
}

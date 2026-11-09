"use client";

import { useEffect, useMemo, useState } from "react";
import CopyButton from "./copy-button";
import type { Numstat } from "./types";
import type { WorktreeDiffCapture } from "./worktree-diff";
import {
  WORKTREE_DIFF_CAPTURE_LIMIT,
  WORKTREE_EXCLUSION_REASONS,
  buildWorktreeDiffCaptureJson,
  buildWorktreeDiffCaptureMarkdown,
  buildWorktreeExcludedJsonl,
  compareWorktreeDiffCaptures,
  filterWorktreeExclusions,
  worktreeExclusionReasonLabel,
  worktreeExclusionRows,
} from "./worktree-diff-capture-tools.mjs";
import { worktreePatchDownloadName } from "./worktree-diff-tools.mjs";
import "./worktree-diff-captures.css";

const PAGE_SIZE = 50;

type CaptureProps = {
  capture: WorktreeDiffCapture;
  history: WorktreeDiffCapture[];
  onSelect: (id: number) => void;
};

function captureTime(capture: WorktreeDiffCapture) {
  return new Date(capture.received_at).toLocaleString();
}

function PageControls({ page, count, onChange, label }: { page: number; count: number; onChange: (page: number) => void; label: string }) {
  const pages = Math.ceil(count / PAGE_SIZE);
  if (pages <= 1) return null;
  return <nav className="worktree-capture-pages" aria-label={label}>
    <button type="button" disabled={page === 0} onClick={() => onChange(page - 1)}>前の{PAGE_SIZE}件</button>
    <span role="status">{page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, count)} / {count} 件</span>
    <button type="button" disabled={page + 1 >= pages} onClick={() => onChange(page + 1)}>次の{PAGE_SIZE}件</button>
  </nav>;
}

function ExcludedInventory({ capture }: { capture: WorktreeDiffCapture }) {
  const [reason, setReason] = useState("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const rows = useMemo(() => worktreeExclusionRows(capture.response.excluded), [capture]);
  const visible = useMemo(() => filterWorktreeExclusions(rows, reason, query), [rows, reason, query]);
  const jsonl = useMemo(() => buildWorktreeExcludedJsonl(capture, reason, query), [capture, reason, query]);
  useEffect(() => setPage(0), [capture.id, reason, query]);

  return <details className="worktree-capture-exclusions">
    <summary>APIが報告した除外パス <strong>{rows.length} 件</strong></summary>
    <p className="worktree-capture-note">未追跡はファイル単位で指定した場合だけ報告されます。この一覧は全未追跡ファイルの一覧ではありません。</p>
    <div className="worktree-capture-filters">
      <label><span>除外の理由</span><select aria-label="作業ツリー差分の除外理由" value={reason} onChange={(event) => setReason(event.target.value)}>
        <option value="all">すべて</option>
        {WORKTREE_EXCLUSION_REASONS.map((value) => <option key={value} value={value}>{worktreeExclusionReasonLabel(value)}</option>)}
      </select></label>
      <label><span>除外パスを検索</span><input type="search" aria-label="作業ツリー差分の除外パスを検索" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="パスの一部（文字列）" /></label>
      <span className="worktree-capture-count" role="status">{visible.length} / {rows.length} 件</span>
      {visible.length > 0 && <CopyButton value={jsonl} label="表示中の除外パスを理由付きJSONLでコピー" />}
    </div>
    {visible.length === 0 ? <p className="worktree-capture-note" role="status">{rows.length === 0 ? "この取得結果では除外パスは報告されていません。" : "条件に一致する除外パスはありません。"}</p> : <div className="worktree-capture-table-wrap">
      <table><caption className="sr-only">取得した差分対象外パス</caption><thead><tr><th scope="col">理由</th><th scope="col">パス（JSON表記）</th></tr></thead>
        <tbody>{visible.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((row: { reason: string; path: string }, index: number) => <tr key={`${row.reason}:${row.path}:${index}`}><td>{worktreeExclusionReasonLabel(row.reason)}</td><td><code>{JSON.stringify(row.path)}</code></td></tr>)}</tbody>
      </table>
    </div>}
    <PageControls page={page} count={visible.length} onChange={setPage} label="除外パスのページ" />
  </details>;
}

function fileMetadata(file: Numstat | null) {
  if (file === null) return "差分一覧に含まれない";
  const parts = [`+${file.additions === "-" ? "不明" : file.additions}`, `−${file.deletions === "-" ? "不明" : file.deletions}`];
  if (file.binary) parts.push("バイナリ");
  if (file.old_path !== undefined) parts.push(`変更元 ${JSON.stringify(file.old_path)}`);
  return parts.join(" / ");
}

function transitionLabel(kind: string, excluded: boolean) {
  if (kind === "entered") return excluded ? "報告に加わった" : "差分に入った";
  if (kind === "left") return excluded ? "報告から外れた" : "差分から外れた";
  if (kind === "metadata_changed") return "行数・種類・変更元が変化";
  if (kind === "reason_changed") return "除外理由が変化";
  throw new RangeError(`Unknown capture transition: ${kind}`);
}

function reasonsLabel(reasons: string[]) {
  return reasons.length === 0 ? "報告なし" : reasons.map(worktreeExclusionReasonLabel).join("、");
}

function CaptureComparison({ before, after }: { before: WorktreeDiffCapture; after: WorktreeDiffCapture }) {
  const [filePage, setFilePage] = useState(0);
  const [excludedPage, setExcludedPage] = useState(0);
  const comparison = useMemo(() => compareWorktreeDiffCaptures(before, after), [before, after]);
  const patchLabels = {
    same: "取得した完全パッチの本文は同一です。",
    different: "取得した完全パッチの本文が変わりました。行数が同じ場合も本文の変更はあり得ます。",
    same_prefix: "取得できた部分のパッチ本文は同一です。切り詰められた部分は比較できません。",
    different_prefix: "取得できた部分のパッチ本文が変わりました。切り詰められた部分は比較できません。",
  };
  return <details className="worktree-capture-comparison" open>
    <summary>直前の取得結果との比較</summary>
    <p className="worktree-capture-note">#{before.id}（{captureTime(before)}）→ #{after.id}（{captureTime(after)}）。同じリポジトリ・ステージ・ファイル範囲・空白設定を比較しています。</p>
    <p className="worktree-capture-patch-comparison" role="status">{patchLabels[comparison.patch_comparison as keyof typeof patchLabels]}</p>
    <h5>追跡ファイルの差分一覧の変化 <span>{comparison.files.length} 件</span></h5>
    <p className="worktree-capture-note">「差分から外れた」は、この差分一覧に含まれなくなったことを表します。ファイルの削除やコミット完了を判定するものではありません。</p>
    {!comparison.metadata_complete ? <p className="worktree-capture-note" role="status">一覧が不完全な取得結果を含むため、ファイルの増減・行数は比較できません。</p> : comparison.files.length === 0 ? <p className="worktree-capture-note" role="status">変更パス・行数・種類・変更元の情報に差はありません。</p> : <div className="worktree-capture-table-wrap">
      <table><caption className="sr-only">直前の取得結果から変わった追跡ファイル</caption><thead><tr><th scope="col">変化</th><th scope="col">パス（JSON表記）</th><th scope="col">前回</th><th scope="col">選択中の取得</th></tr></thead>
        <tbody>{comparison.files.slice(filePage * PAGE_SIZE, (filePage + 1) * PAGE_SIZE).map((row: { path: string; kind: string; before: Numstat | null; after: Numstat | null }) => <tr key={row.path}><td>{transitionLabel(row.kind, false)}</td><td><code>{JSON.stringify(row.path)}</code></td><td>{fileMetadata(row.before)}</td><td>{fileMetadata(row.after)}</td></tr>)}</tbody>
      </table>
    </div>}
    {comparison.metadata_complete && <PageControls page={filePage} count={comparison.files.length} onChange={setFilePage} label="追跡ファイル比較のページ" />}
    <h5>除外パスの報告の変化 <span>{comparison.exclusions.length} 件</span></h5>
    <p className="worktree-capture-note">APIの報告の差を表示します。「報告から外れた」だけで競合解消やファイルの存在は判定しません。</p>
    {comparison.exclusions.length === 0 ? <p className="worktree-capture-note" role="status">報告された除外パスと理由に差はありません。</p> : <div className="worktree-capture-table-wrap">
      <table><caption className="sr-only">直前の取得結果から変わった除外パスの報告</caption><thead><tr><th scope="col">変化</th><th scope="col">パス（JSON表記）</th><th scope="col">前回の理由</th><th scope="col">選択中の理由</th></tr></thead>
        <tbody>{comparison.exclusions.slice(excludedPage * PAGE_SIZE, (excludedPage + 1) * PAGE_SIZE).map((row: { path: string; kind: string; before: string[]; after: string[] }) => <tr key={row.path}><td>{transitionLabel(row.kind, true)}</td><td><code>{JSON.stringify(row.path)}</code></td><td>{reasonsLabel(row.before)}</td><td>{reasonsLabel(row.after)}</td></tr>)}</tbody>
      </table>
    </div>}
    <PageControls page={excludedPage} count={comparison.exclusions.length} onChange={setExcludedPage} label="除外パス比較のページ" />
  </details>;
}

export default function WorktreeDiffCaptures({ capture, history, onSelect }: CaptureProps) {
  const [exportStatus, setExportStatus] = useState("");
  const report = useMemo(() => buildWorktreeDiffCaptureMarkdown(capture), [capture]);
  const index = history.findIndex((item) => item.id === capture.id);
  const previous = index >= 0 && index + 1 < history.length ? history[index + 1] : null;
  const latest = history.length > 0 && history[0].id === capture.id;
  useEffect(() => setExportStatus(""), [capture.id]);

  const exportCapture = () => {
    try {
      const url = URL.createObjectURL(new Blob([buildWorktreeDiffCaptureJson(capture)], { type: "application/json;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = worktreePatchDownloadName({ stage: capture.response.stage, file: capture.response.file, patch_truncated: capture.response.patch_truncated }).replace(/\.patch$/, `-capture-${capture.id}.json`);
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportStatus("取得記録JSONの保存を開始しました。");
    } catch {
      setExportStatus("取得記録JSONを保存できませんでした。");
    }
  };

  return <div className="worktree-captures">
    <div className="worktree-capture-history">
      <label><span>この画面の取得履歴</span><select aria-label="表示する作業ツリー差分の取得結果" value={capture.id} onChange={(event) => onSelect(Number(event.target.value))}>
        {history.map((item, itemIndex) => <option key={item.id} value={item.id}>#{item.id} {captureTime(item)} · {item.response.stats.files}ファイル{itemIndex === 0 ? "（最新の取得）" : "（過去の取得）"}</option>)}
      </select></label>
      {!latest && <button type="button" onClick={() => onSelect(history[0].id)}>最新の取得結果を表示</button>}
      <p className="worktree-capture-note">この画面を開いている間の最新{WORKTREE_DIFF_CAPTURE_LIMIT}件を保持し、同じ取得条件の履歴を表示します。日時はブラウザが応答を受信した時刻です。</p>
      {!latest && <p className="worktree-capture-historical" role="status">過去の取得結果を表示しています。現在の作業ツリーとは異なる場合があります。</p>}
    </div>
    <div className="worktree-capture-exports">
      <button type="button" onClick={exportCapture}>取得記録をJSONで保存</button>
      <CopyButton value={report} label="取得記録をMarkdownでコピー" />
      <span className="worktree-capture-export-status" role="status" aria-live="polite">{exportStatus}</span>
    </div>
    <ExcludedInventory capture={capture} />
    {previous === null ? <p className="worktree-capture-note">同じ条件で2回取得すると、直前の取得結果との比較を表示できます。</p> : <CaptureComparison key={`${previous.id}:${capture.id}`} before={previous} after={capture} />}
  </div>;
}

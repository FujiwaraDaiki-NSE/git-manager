"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CopyButton from "./copy-button";
import { uniqueLocalForCommit } from "./project-flow.mjs";
import {
  filterHistory,
  encodeHistoryAuthor,
  hasUnknownAuthor,
  historyAuthors,
  historyCsv,
  historyDateRangeError,
  historyHashList,
  historyLogCommand,
  historyRequestKey,
  sortHistory,
  UNKNOWN_AUTHOR_FILTER,
} from "./branch-history-tools.mjs";
import type { ProjectBranchCommit, ProjectBranchRow, ProjectEvent, ProjectLane, ProjectResponse } from "./types";

type HistoryKind = "all" | "merge" | "regular";
type HistoryOrder = "git" | "newest" | "oldest";

type HistoryRecord = {
  hash: string;
  subject: string | null;
  author: string | null;
  date: string | null;
  parents: string[] | null;
  isMerge: boolean | null;
  event: ProjectEvent;
};

type HistoryPage = {
  commits: ProjectBranchCommit[];
  next_offset: number | null;
};

function exactDate(value: string | null) {
  if (!value) return "未取得";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "未取得" : date.toLocaleString("ja-JP");
}

function shortHash(value: string) {
  return value.slice(0, 8);
}

function metadataMap(row: ProjectBranchRow) {
  const result = new Map<string, ProjectBranchCommit>();
  row.commits.forEach((commit) => result.set(commit.hash, commit));
  // Tip metadata is keyed by hash because the order of history_heads is not a
  // contract for metadata order.
  row.tip_commits.forEach((commit) => result.set(commit.hash, commit));
  return result;
}

function commitEvent(
  project: ProjectResponse,
  row: ProjectBranchRow,
  hash: string,
  metadata: ProjectBranchCommit | null,
  parents: string[] | null,
): ProjectEvent {
  const local = uniqueLocalForCommit(row.locals, hash) as ProjectLane | null;
  const existing = project.events.find((event) => event.type === "commit" && event.commit_hash === hash);
  return {
    ...(existing ?? {}),
    id: existing?.id ?? `branch-history:${row.id}:${hash}`,
    occurred_at: metadata?.date ?? existing?.occurred_at ?? null,
    observed_at: existing?.observed_at ?? project.observed_at,
    type: "commit",
    source: "git",
    project_id: project.id,
    // A row gives branch context, but a lane is only assigned when this hash
    // is the unique local HEAD. Shared history and remote tips stay lane-less.
    worktree: local?.path ?? null,
    branch: local?.branch ?? row.name,
    lane_id: local?.id ?? null,
    lane_names: [row.name, ...(local?.branch ? [local.branch] : [])],
    commit_hash: hash,
    subject: metadata?.subject ?? existing?.subject ?? null,
    author: metadata?.author ?? existing?.author ?? null,
    parents: parents ?? existing?.parents ?? [],
    stats: existing?.stats ?? null,
  };
}

function recordsForRow(project: ProjectResponse, row: ProjectBranchRow): HistoryRecord[] {
  const metadata = metadataMap(row);
  const hashes = Array.from(new Set([
    ...row.commit_hashes,
    ...row.commits.map((commit) => commit.hash),
    ...row.tip_commits.map((commit) => commit.hash),
  ]));
  return hashes.map((hash) => {
    const detail = metadata.get(hash) ?? null;
    const existing = project.events.find((event) => event.type === "commit" && event.commit_hash === hash);
    // Parent metadata is the only source used to classify a row. If neither
    // source has parents, keep the kind unknown instead of calling it regular.
    const parents = Array.isArray(detail?.parents)
      ? detail.parents
      : Array.isArray(existing?.parents)
        ? existing.parents
        : null;
    return {
      hash,
      subject: detail?.subject ?? existing?.subject ?? null,
      author: detail?.author ?? existing?.author ?? null,
      date: detail?.date ?? existing?.occurred_at ?? null,
      parents,
      isMerge: parents === null ? null : parents.length > 1,
      event: commitEvent(project, row, hash, detail, parents),
    };
  });
}

function rowLabel(row: ProjectBranchRow) {
  return row.remote_ref ? `${row.name} · ${row.remote_ref}` : row.name;
}

function historyCoverage(row: ProjectBranchRow, offset: number | null) {
  if (!row.history_available) return "履歴未取得";
  return offset === null ? "追加ページなし" : "追加ページあり";
}

function kindLabel(kind: boolean | null) {
  if (kind === true) return "merge";
  if (kind === false) return "通常";
  return "種類未取得";
}

export default function BranchHistoryExplorer({
  project,
  onSelect,
}: {
  project: ProjectResponse;
  onSelect: (event: ProjectEvent, branchRowId?: string) => void;
}) {
  const rows = project.branch_rows ?? [];
  const [open, setOpen] = useState(false);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<HistoryKind>("all");
  const [authorFilter, setAuthorFilter] = useState("");
  const [startDate, setStartDate] = useState<string | null>(null);
  const [endDate, setEndDate] = useState<string | null>(null);
  const [order, setOrder] = useState<HistoryOrder>("git");
  const [visibleCount, setVisibleCount] = useState(20);
  const [extraCommits, setExtraCommits] = useState<ProjectBranchCommit[]>([]);
  const [historyOffset, setHistoryOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState("");
  const requestIdentityRef = useRef<string | null>(null);
  const requestControllerRef = useRef<AbortController | null>(null);

  // Project identity changes are a new investigation context. No row is
  // selected implicitly when that happens.
  useEffect(() => {
    setSelectedRowId(null);
  }, [project.id, project.main_path]);

  const selectedRow = rows.find((row) => row.id === selectedRowId) ?? null;
  const selectedIdentity = useMemo(() => {
    if (!selectedRow) return null;
    return historyRequestKey(
      project.main_path,
      selectedRow.id,
      selectedRow.history_heads,
      [
        ...selectedRow.commit_hashes,
        ...selectedRow.commits.map((commit) => commit.hash),
        ...selectedRow.tip_commits.map((commit) => commit.hash),
      ],
    );
  }, [project.main_path, selectedRow]);

  useEffect(() => {
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    requestIdentityRef.current = selectedIdentity;
    setExtraCommits([]);
    setVisibleCount(20);
    setHistoryOffset(selectedRow?.history_cursor ?? null);
    setLoading(false);
    setError(null);
    setExportStatus("");
    return () => {
      if (requestIdentityRef.current === selectedIdentity) requestControllerRef.current?.abort();
    };
  }, [selectedIdentity, selectedRow?.history_cursor]);

  const records = useMemo(() => {
    if (!selectedRow) return [];
    const initial = recordsForRow(project, selectedRow);
    const known = new Set(initial.map((commit) => commit.hash));
    const extras = extraCommits.filter((commit) => !known.has(commit.hash));
    return [...initial, ...recordsForRow(project, { ...selectedRow, commits: extras, commit_hashes: extras.map((commit) => commit.hash), tip_commits: [] })];
  }, [extraCommits, project, selectedRow]);

  const dateRangeError = useMemo(() => historyDateRangeError(startDate, endDate), [endDate, startDate]);
  const filtered = useMemo(
    () => sortHistory(filterHistory(records, query, kind, authorFilter, startDate, endDate), order) as HistoryRecord[],
    [authorFilter, endDate, kind, order, query, records, startDate],
  );
  const shown = filtered.slice(0, visibleCount);
  const hasBuffered = shown.length < filtered.length;
  const canLoadPage = !dateRangeError && !hasBuffered && historyOffset !== null && Boolean(selectedRow?.history_heads.length);

  const authors = useMemo(() => historyAuthors(records), [records]);
  const includesUnknownAuthor = useMemo(() => hasUnknownAuthor(records), [records]);
  const historyCommand = useMemo(
    () => selectedRow ? historyLogCommand(project.main_path, selectedRow.history_heads) : null,
    [project.main_path, selectedRow],
  );

  useEffect(() => {
    setVisibleCount(20);
    setExportStatus("");
  }, [authorFilter, endDate, kind, order, query, startDate]);

  const exportCsv = useCallback(() => {
    if (!filtered.length) return;
    const url = URL.createObjectURL(new Blob([historyCsv(filtered)], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "gitdash-branch-history.csv";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setExportStatus(`${filtered.length}件のCSV保存を開始しました`);
  }, [filtered]);

  const loadMore = useCallback(async () => {
    if (loading) return;
    if (hasBuffered) {
      setVisibleCount((count) => count + 20);
      return;
    }
    if (!selectedRow || historyOffset === null || selectedRow.history_heads.length === 0 || selectedIdentity === null) return;
    const requestKey = selectedIdentity;
    const controller = new AbortController();
    requestControllerRef.current?.abort();
    requestControllerRef.current = controller;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ path: project.main_path, offset: String(historyOffset) });
    selectedRow.history_heads.forEach((head) => params.append("heads", head));
    try {
      const response = await fetch(`/api/repo/branch-history?${params.toString()}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const page = await response.json() as HistoryPage;
      if (requestIdentityRef.current !== requestKey) return;
      setExtraCommits((current) => {
        const known = new Set(current.map((commit) => commit.hash));
        return [...current, ...page.commits.filter((commit) => !known.has(commit.hash))];
      });
      setHistoryOffset(page.next_offset);
      setVisibleCount((count) => count + 20);
    } catch (caught) {
      if (requestIdentityRef.current !== requestKey || (caught instanceof DOMException && caught.name === "AbortError")) return;
      setError("追加の履歴を取得できませんでした。条件を保ったまま再試行できます。");
    } finally {
      if (requestIdentityRef.current === requestKey && requestControllerRef.current === controller) {
        requestControllerRef.current = null;
        setLoading(false);
      }
    }
  }, [hasBuffered, historyOffset, loading, project.main_path, selectedIdentity, selectedRow]);

  const selectedTips = selectedRow?.history_heads.map((hash) => ({ hash, metadata: selectedRow ? metadataMap(selectedRow).get(hash) ?? null : null })) ?? [];

  return (
    <section className="branch-history-explorer" aria-labelledby="branch-history-explorer-title">
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary id="branch-history-explorer-title">ブランチ履歴を調査 <span>検索・作成者・日付・CSV・コピー</span></summary>
        <div className="branch-history-explorer-body">
          <div className="branch-history-explorer-heading">
            <div>
              <h3>到達可能なコミットを表で確認</h3>
              <p>ブランチを明示的に選ぶと、取得済み履歴だけを検索できます。未取得の履歴は検索対象になりません。</p>
            </div>
            {project.branch_rows === null && <span className="branch-history-explorer-state" role="status">ブランチ行を取得できません。</span>}
          </div>

          <div className="branch-history-explorer-selector">
            <label>
              <span>対象ブランチ</span>
              <select aria-label="履歴を調べるブランチ" value={selectedRowId ?? ""} onChange={(event) => setSelectedRowId(event.target.value || null)}>
                <option value="">ブランチを選択</option>
                {rows.map((row) => <option key={row.id} value={row.id}>{rowLabel(row)}</option>)}
              </select>
            </label>
            {selectedRow && <div className="branch-history-explorer-tip" aria-label="選択中ブランチの先端">
              <span>先端</span>
              {selectedTips.length ? selectedTips.map(({ hash, metadata }) => <code key={hash} title={metadata?.subject ?? undefined}>{shortHash(hash)}{metadata ? ` · ${metadata.subject || "件名未取得"}` : " · メタデータ未取得"}</code>) : <span>未取得</span>}
            </div>}
          </div>

          {!selectedRow && selectedRowId !== null && <p className="branch-history-explorer-state" role="status">選択中のブランチ行は現在のスナップショットにありません。別のブランチを選んでください。</p>}
          {!selectedRow && selectedRowId === null && <p className="branch-history-explorer-empty" role="status">{project.branch_rows === null ? "ブランチ行が未取得のため、履歴を選択できません。" : rows.length === 0 ? "表示できるブランチがありません。" : "ブランチを選ぶまで履歴は読み込みません。"}</p>}

          {selectedRow && <>
            <div className="history-tools branch-history-explorer-tools" role="group" aria-label={`${selectedRow.name} の履歴操作`}>
              <label><span>検索</span><input aria-label={`${selectedRow.name} のコミットを検索`} type="search" placeholder="件名・作成者・ハッシュ（空白でAND）" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
              <label><span>種類</span><select aria-label="コミットの種類" value={kind} onChange={(event) => setKind(event.target.value as HistoryKind)}><option value="all">すべて</option><option value="merge">マージ</option><option value="regular">通常コミット</option></select></label>
              <label><span>作成者（完全一致）</span><select aria-label="作成者で絞り込み" value={authorFilter} onChange={(event) => setAuthorFilter(event.target.value)}><option value="">すべて</option>{authors.map((author) => <option key={author} value={encodeHistoryAuthor(author)}>{author}</option>)}{includesUnknownAuthor && <option value={UNKNOWN_AUTHOR_FILTER}>作成者未取得</option>}</select></label>
              <label><span>開始日（ローカル）</span><input aria-describedby={dateRangeError ? "branch-history-date-error" : undefined} aria-invalid={Boolean(dateRangeError)} aria-label="履歴の開始日" type="date" value={startDate ?? ""} onChange={(event) => setStartDate(event.target.value === "" ? null : event.target.value)} /></label>
              <label><span>終了日（ローカル）</span><input aria-describedby={dateRangeError ? "branch-history-date-error" : undefined} aria-invalid={Boolean(dateRangeError)} aria-label="履歴の終了日" type="date" value={endDate ?? ""} onChange={(event) => setEndDate(event.target.value === "" ? null : event.target.value)} /></label>
              <label><span>並び順</span><select aria-label="コミットの並び順" value={order} onChange={(event) => setOrder(event.target.value as HistoryOrder)}><option value="git">Gitの履歴順</option><option value="newest">日時が新しい順</option><option value="oldest">日時が古い順</option></select></label>
              <button className="subtle-button" type="button" disabled={!query && kind === "all" && !authorFilter && startDate === null && endDate === null && order === "git"} onClick={() => { setQuery(""); setKind("all"); setAuthorFilter(""); setStartDate(null); setEndDate(null); setOrder("git"); }}>条件をリセット</button>
              <button className="subtle-button" type="button" disabled={!filtered.length} onClick={exportCsv}>一致する履歴をCSV保存</button>
              {filtered.length > 0 && <CopyButton value={historyHashList(filtered)} label="一致するコミットのハッシュをコピー" />}
              {historyCommand && <CopyButton value={historyCommand} label="選択ブランチの git log コマンドをコピー" />}
            </div>

            {dateRangeError && <p className="branch-history-explorer-date-error" id="branch-history-date-error" role="alert">{dateRangeError}</p>}

            <div className="branch-history-explorer-coverage" role="status">
              <span>表示 {shown.length} / 一致 {filtered.length} / 取得済み {records.length}件</span>
              <span>履歴カバレッジ: {historyCoverage(selectedRow, historyOffset)}</span>
              {exportStatus && <span>{exportStatus}</span>}
            </div>

            {records.length === 0 ? <p className="branch-history-explorer-empty" role="status">{selectedRow.history_available ? "このブランチの取得済み履歴はありません。" : "履歴を取得できませんでした。"}</p> : filtered.length === 0 ? <p className="branch-history-explorer-empty" role="status">{dateRangeError ? "日付範囲が無効なため、コミットを表示できません。" : "取得済み履歴に一致するコミットはありません。条件を変えてください。"}</p> : <div className="branch-history-table-wrap" role="region" aria-label={`${selectedRow.name} のコミット履歴`} tabIndex={0}>
              <table className="branch-history-table">
                <thead><tr><th scope="col">ハッシュ</th><th scope="col">件名</th><th scope="col">作成者</th><th scope="col">日時</th><th scope="col">種類</th><th scope="col"><span className="sr-only">操作</span></th></tr></thead>
                <tbody>{shown.map((commit) => <tr key={commit.hash}>
                  <td className="branch-history-hash"><code title={commit.hash}>{shortHash(commit.hash)}</code><CopyButton value={commit.hash} label={`${shortHash(commit.hash)} をコピー`} /></td>
                  <td className="branch-history-subject">{commit.subject ?? "件名未取得"}</td>
                  <td>{commit.author || "作成者未取得"}</td>
                  <td><time dateTime={commit.date ?? undefined}>{exactDate(commit.date)}</time></td>
                  <td><span className={`branch-history-kind${commit.isMerge === null ? " is-unknown" : ""}`}>{kindLabel(commit.isMerge)}</span></td>
                  <td><button className="table-action" type="button" onClick={() => onSelect(commit.event, selectedRow.id)}>詳細</button></td>
                </tr>)}</tbody>
              </table>
            </div>}

            {(hasBuffered || canLoadPage) && <button className="branch-history-more branch-history-explorer-more" type="button" onClick={() => void loadMore()} disabled={loading}>{loading ? "履歴を取得中…" : `さらに表示（${hasBuffered ? "取得済みから" : "次のページを"}）`}</button>}
            {error && <p className="branch-history-explorer-error" role="alert">{error} <button className="subtle-button" type="button" onClick={() => void loadMore()}>再試行</button></p>}
            {!selectedRow.commit_metadata_available && <p className="branch-history-explorer-note" role="status">一部のコミットで件名・作成者・日時・親情報を取得できていません。種類未取得は通常コミットとして扱っていません。</p>}
          </>}
        </div>
      </details>
    </section>
  );
}

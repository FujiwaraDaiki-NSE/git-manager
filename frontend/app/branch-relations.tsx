"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  connectionPairs,
  connectionRefs,
  coverageLabels,
  edgeReferenceIds,
  evidenceLabel,
  filterReferencePairs,
  operationLabel,
  preferredReferenceId,
  referenceDisplayName,
  reasonLabel,
  refKindLabel,
  relationLabel,
  selectReferencePairs,
  syncSelectedReferenceId,
} from "./branch-relations-tools.mjs";
import type {
  ProjectBranchConnectionEdge,
  ProjectBranchConnectionUnresolved,
  ProjectBranchConnectionRef,
  ProjectBranchRow,
  ProjectResponse,
} from "./types";

function exactDate(value: string | null | undefined) {
  if (!value) return "未取得";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "未取得" : date.toLocaleString("ja-JP");
}

function shortHash(value: string | null | undefined) {
  return value ? value.slice(0, 10) : "未取得";
}

function hashText(value: string | null | undefined) {
  return value ? <code title={value}>{shortHash(value)}</code> : <span>未取得</span>;
}

function rowName(rows: ProjectBranchRow[], rowId: string | null | undefined) {
  if (!rowId) return null;
  const row = rows.find((item) => item.id === rowId);
  return row?.name ?? null;
}

function refName(refs: ProjectBranchConnectionRef[], id: string | null | undefined, missingLabel: string) {
  if (!id) return missingLabel;
  const ref = refs.find((item) => item.id === id);
  return ref ? referenceDisplayName(ref) : `削除済み参照 · ${id}`;
}

function endpointLabel(
  edge: ProjectBranchConnectionEdge,
  side: "source" | "target",
  refs: ProjectBranchConnectionRef[],
  rows: ProjectBranchRow[],
) {
  const ids = edgeReferenceIds(edge, refs);
  const id = side === "source" ? ids.source : ids.target;
  const recordedLabel = side === "source" ? edge.source : edge.target;
  if (id) {
    const ref = refs.find((item) => item.id === id);
    if (ref) return `${referenceDisplayName(ref)}（${refKindLabel(ref.kind)}）`;
    if (typeof recordedLabel === "string" && recordedLabel) return `${recordedLabel}（履歴上の参照名・現在の対応なし）`;
    return `削除済み参照 · ${id}`;
  }
  const rowId = side === "source" ? edge.source_row_id : edge.target_row_id;
  if (typeof recordedLabel === "string" && recordedLabel) return `${recordedLabel}（履歴上の参照名・現在の対応なし）`;
  const row = rowName(rows, rowId);
  if (row) return `${row}（参照種別未取得）`;
  return side === "source" ? "操作元の参照未取得" : "操作先の参照未取得";
}

function edgeTimeLabel(edge: ProjectBranchConnectionEdge) {
  if (edge.occurred_at !== null && edge.occurred_at !== undefined) return `操作時刻 ${exactDate(edge.occurred_at)}`;
  if (edge.operation) return "操作時刻未取得";
  const commitDate = edge.target_commit?.date ?? edge.source_commit?.date ?? null;
  return commitDate ? `commit日時 ${exactDate(commitDate)}` : "操作時刻未取得";
}

function statusLabel(status: ProjectResponse["branch_connections"] extends infer T ? T extends { status: infer S } ? S : never : never) {
  if (status === "available") return "取得済み";
  if (status === "partial") return "一部取得";
  return "未取得";
}

function edgeMatchesQuery(
  edge: ProjectBranchConnectionEdge,
  refs: ProjectBranchConnectionRef[],
  rows: ProjectBranchRow[],
  query: string,
) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const text = [
    edge.label,
    edge.evidence,
    edge.operation,
    edge.source,
    edge.target,
    edge.commit_hash,
    edge.source_commit_hash,
    edge.target_commit_hash,
    endpointLabel(edge, "source", refs, rows),
    endpointLabel(edge, "target", refs, rows),
    edge.pr_number === null || edge.pr_number === undefined ? "" : `pr ${edge.pr_number}`,
  ].filter(Boolean).join(" ").toLocaleLowerCase();
  return terms.every((term) => text.includes(term));
}

function RelationBadge({ relation }: { relation: string }) {
  return <span className={`branch-relation-badge is-${relation}`}>{relationLabel(relation)}</span>;
}

function RefName({ reference: ref }: { reference: ProjectBranchConnectionRef | undefined }) {
  if (!ref) return <span className="branch-relation-ref-missing">参照未取得</span>;
  return <span className="branch-relation-ref" title={ref.id}><span className={`branch-relation-ref-kind is-${ref.kind}`}>{refKindLabel(ref.kind)}</span><strong>{referenceDisplayName(ref)}</strong></span>;
}

function RelationPairRow({
  item,
  selectedRef,
  refsById,
}: {
  item: ReturnType<typeof selectReferencePairs>[number];
  selectedRef: ProjectBranchConnectionRef | undefined;
  refsById: Map<string, ProjectBranchConnectionRef>;
}) {
  const other = refsById.get(item.otherRefId);
  const counts = item.selectedOnly === null || item.otherOnly === null
    ? "差分件数未取得"
    : `この参照のみ ${item.selectedOnly} · 相手のみ ${item.otherOnly}`;
  return <li className={`branch-relation-pair is-${item.relation}`}>
    <div className="branch-relation-pair-main"><RefName reference={selectedRef} /><span aria-hidden="true">↔</span><RefName reference={other} /><RelationBadge relation={item.relation} /></div>
    <div className="branch-relation-pair-facts"><span>{counts}</span>{item.mergeBases === null ? <span>共通祖先未取得</span> : item.mergeBases.length ? <span>共通祖先 {item.mergeBases.map((hash: string) => hashText(hash))}</span> : <span>共通祖先なし</span>}{item.pair.reason && <span>{reasonLabel(item.pair.reason)}</span>}</div>
  </li>;
}

function ConnectionEventRow({
  edge,
  refs,
  rows,
  selectedRefId,
}: {
  edge: ProjectBranchConnectionEdge;
  refs: ProjectBranchConnectionRef[];
  rows: ProjectBranchRow[];
  selectedRefId: string | null;
}) {
  const ids = edgeReferenceIds(edge, refs);
  const selected = selectedRefId && (ids.source === selectedRefId || ids.target === selectedRefId);
  return <li className={`branch-relation-event${selected ? " is-selected" : ""}`}>
    <div className="branch-relation-event-head"><strong>{endpointLabel(edge, "source", refs, rows)} → {endpointLabel(edge, "target", refs, rows)}</strong><span className={`branch-relation-evidence is-${edge.evidence}`}>{evidenceLabel(edge.evidence)}</span>{edge.operation && <span className="branch-relation-operation">{operationLabel(edge.operation)}</span>}</div>
    <div className="branch-relation-event-meta"><span>{edgeTimeLabel(edge)}</span><span>{edge.label || "関係イベント"}</span>{edge.pr_number !== null && edge.pr_number !== undefined && (edge.pr_url ? <a href={edge.pr_url} target="_blank" rel="noreferrer">PR #{edge.pr_number}</a> : <span>PR #{edge.pr_number}</span>)}</div>
    <div className="branch-relation-event-hashes"><span>取り込み元 {hashText(edge.source_commit_hash ?? edge.source_commit?.hash ?? null)}</span><span>取り込み先 {hashText(edge.target_commit_hash ?? edge.target_commit?.hash ?? null)}</span><span>根拠コミット {hashText(edge.commit_hash)}</span></div>
    {(!ids.source || !ids.target) && <p className="branch-relation-event-note">取り込み元・先の参照 ID の一意な対応付けは未取得です。行名だけから参照を推測していません。</p>}
    {edge.source_row_id && !rowName(rows, edge.source_row_id) && <p className="branch-relation-event-note">操作元のブランチ行は現在の一覧にありません。</p>}
  </li>;
}

export default function BranchRelations({
  project,
  selectedRowId,
  selectedLane,
  relationRef,
}: {
  project: ProjectResponse;
  selectedRowId: string | null;
  selectedLane: string | null;
  relationRef: string | null;
}) {
  const connection = project.branch_connections;
  const refs: ProjectBranchConnectionRef[] = useMemo(() => connectionRefs(connection) as ProjectBranchConnectionRef[], [connection]);
  const pairs = useMemo(() => connectionPairs(connection), [connection]);
  const rows = project.branch_rows ?? [];
  const refsById = useMemo(() => new Map(refs.map((ref) => [ref.id, ref])), [refs]);
  const preferred = useMemo(() => preferredReferenceId(refs, selectedRowId, selectedLane, relationRef), [refs, selectedLane, selectedRowId, relationRef]);
  const [selectedRefId, setSelectedRefId] = useState<string | null>(preferred);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(true);
  const [showAllUnresolved, setShowAllUnresolved] = useState(false);
  const selectionContext = JSON.stringify([selectedRowId, selectedLane, relationRef]);
  const previousSelectionContext = useRef(selectionContext);
  useEffect(() => {
    const contextChanged = previousSelectionContext.current !== selectionContext;
    previousSelectionContext.current = selectionContext;
    setSelectedRefId((current) => syncSelectedReferenceId(current, preferred, contextChanged, refsById));
  }, [preferred, refsById, selectionContext]);
  useEffect(() => {
    setQuery("");
    setShowAllUnresolved(false);
  }, [project.id, project.main_path]);

  const oriented = useMemo(() => selectReferencePairs(pairs, selectedRefId), [pairs, selectedRefId]);
  const filteredPairs = useMemo(() => filterReferencePairs(oriented, refsById, query), [oriented, query, refsById]);
  const edges = connection?.edges ?? [];
  const filteredEdges = useMemo(() => edges.filter((edge) => {
    const ids = edgeReferenceIds(edge, refs);
    const isRelated = !selectedRefId || ids.source === selectedRefId || ids.target === selectedRefId;
    return isRelated && edgeMatchesQuery(edge, refs, rows, query);
  }), [edges, query, refs, rows, selectedRefId]);
  const unresolved: ProjectBranchConnectionUnresolved[] = connection?.unresolved ?? [];
  const filteredUnresolved = useMemo(() => {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return unresolved.filter((item) => {
      const related = !selectedRefId || item.source_ref_id === selectedRefId || item.target_ref_id === selectedRefId;
      if (!showAllUnresolved && !related) return false;
      if (!terms.length) return true;
      const haystack = [
        item.source,
        item.target,
        item.reason,
        item.evidence,
        item.operation,
        item.commit_hash,
        item.source_commit_hash,
        item.target_commit_hash,
        item.pr_number === null || item.pr_number === undefined ? "" : `pr ${item.pr_number}`,
      ].filter(Boolean).join(" ").toLocaleLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [query, selectedRefId, showAllUnresolved, unresolved]);
  const counts: Record<string, number> = useMemo(() => (oriented as Array<{ relation: string }>).reduce<Record<string, number>>((result, item) => {
    result[item.relation] = (result[item.relation] ?? 0) + 1;
    return result;
  }, {
    equal: 0,
    ahead: 0,
    behind: 0,
    diverged: 0,
    unrelated: 0,
    unknown: 0,
  }), [oriented]);
  const coverage = coverageLabels(connection);
  const hasNewContract = Array.isArray(connection?.refs) || Array.isArray(connection?.pairs);
  const unknownHistoryEdges = selectedRefId ? edges.filter((edge) => {
    const ids = edgeReferenceIds(edge, refs);
    return !ids.source && !ids.target;
  }).length : 0;
  const unknownUnresolved = selectedRefId ? unresolved.filter((item) => !item.source_ref_id && !item.target_ref_id).length : 0;

  return <section className="branch-relations-panel" aria-labelledby="branch-relations-title">
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary id="branch-relations-title">ブランチ・参照の全関係と関連履歴 <span>{hasNewContract ? `${pairs.length}組 · ${refs.length}件の参照` : "関係情報を取得中"}</span></summary>
      <div className="branch-relations-body">
        <div className="branch-relations-heading">
          <div><h3>現在の参照比較と、過去の操作イベント</h3><p>現在の包含関係と過去の分岐・合流は別の事実です。現在の先端が含んでいることだけから、過去の合流元を決めていません。</p></div>
          <span className={`branch-relations-status is-${connection?.status ?? "unavailable"}`}>{statusLabel(connection?.status ?? "unavailable")}</span>
        </div>

        <div className="branch-relations-coverage" role="status">
          <span className={coverage.ancestryClass}>{coverage.ancestry}</span>
          <span className={coverage.reflogClass}>{coverage.reflog}</span>
          <span>PR・共通祖先・reflog の明示的な根拠を使います。</span>
        </div>

        {!connection && <p className="branch-relations-empty" role="status">ブランチ関係情報は未取得です。再走査してから確認してください。</p>}
        {connection && <>
          {refs.length > 0 ? <div className="branch-relations-controls">
            <label><span>対象の参照</span><select aria-label="関係を調べる参照" value={selectedRefId ?? ""} onChange={(event) => setSelectedRefId(event.target.value || null)}><option value="">参照を選択</option>{refs.map((ref) => <option key={ref.id} value={ref.id}>{refKindLabel(ref.kind)} · {referenceDisplayName(ref)}</option>)}</select></label>
            <label className="branch-relations-search"><span>検索</span><input aria-label="関係と履歴を検索" type="search" placeholder="参照名・ハッシュ・PR" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
            <span>{selectedRefId ? `対象 ${oriented.length}組 / 一致 ${filteredPairs.length}組` : "対象の参照を選ぶと全参照との比較を表示"}</span>
          </div> : <p className="branch-relations-empty" role="status">参照一覧は未取得です。ローカルとリモートを分けた比較は表示できません。</p>}

          {refs.length > 0 && selectedRefId && <div className="branch-relations-pair-section">
            <div className="branch-relations-subheading"><h4><RefName reference={refsById.get(selectedRefId)} />との現在の関係</h4><div className="branch-relation-counts">{Object.entries(counts).map(([relation, count]) => count > 0 && <span key={relation}>{relationLabel(relation)} {count}</span>)}</div></div>
            {pairs.length === 0 ? <p className="branch-relations-empty">現在の参照比較は未取得です。ペア情報が返るまでGitの意味を推測しません。</p> : filteredPairs.length === 0 ? <p className="branch-relations-empty">検索条件に一致する関係はありません。</p> : <ul className="branch-relations-pairs" tabIndex={0} aria-label="現在の比較結果（スクロール可能）">{filteredPairs.map((item) => <RelationPairRow item={item} key={`${item.pair.left_ref_id}:${item.pair.right_ref_id}`} refsById={refsById} selectedRef={refsById.get(selectedRefId)} />)}</ul>}
          </div>}

          <div className="branch-relations-history-section">
            <div className="branch-relations-subheading"><h4>{selectedRefId ? "対象の参照に関連する過去イベント" : "過去の分岐・合流イベント"}</h4><span>{filteredEdges.length}件</span></div>
            {filteredEdges.length === 0 ? <p className="branch-relations-empty">表示できる操作イベントはありません。根拠が未取得の履歴は推測していません。</p> : <ul className="branch-relations-events">{filteredEdges.map((edge) => <ConnectionEventRow edge={edge} key={edge.id} refs={refs} rows={rows} selectedRefId={selectedRefId} />)}</ul>}
            {selectedRefId && unknownHistoryEdges > 0 && <p className="branch-relations-note" role="status">{unknownHistoryEdges}件の過去イベントは取り込み元・先の参照 ID が未取得のため、対象の参照には自動追加していません。対象を解除すると全件を確認できます。</p>}
          </div>

          {unresolved.length > 0 && <details className="branch-relations-unresolved"><summary>未解決の関係 ({unresolved.length}件・表示 {filteredUnresolved.length}件)</summary><div className="branch-relations-unresolved-controls"><label><input type="checkbox" checked={showAllUnresolved} onChange={(event) => setShowAllUnresolved(event.target.checked)} /> 対象の参照を特定できない履歴も全件表示</label>{selectedRefId && unknownUnresolved > 0 && <span>{unknownUnresolved}件は取り込み元・先の参照 ID が未取得です。</span>}</div>{filteredUnresolved.length > 0 ? <ul>{filteredUnresolved.map((item) => <li key={item.id}><strong>{item.source_ref_id ? refName(refs, item.source_ref_id, item.source || "操作元の参照未取得") : item.source || "操作元の参照未取得"} → {item.target_ref_id ? refName(refs, item.target_ref_id, item.target || "操作先の参照未取得") : item.target || "操作先の参照未取得"}</strong>{item.evidence && <span>{evidenceLabel(item.evidence)}</span>}{item.operation && <span>{operationLabel(item.operation)}</span>}<span>{item.occurred_at ? `操作時刻 ${exactDate(item.occurred_at)}` : "操作時刻未取得"}</span><span>{reasonLabel(item.reason)}</span>{item.pr_number !== null && item.pr_number !== undefined && (item.pr_url ? <a href={item.pr_url} target="_blank" rel="noreferrer">PR #{item.pr_number}</a> : <span>PR #{item.pr_number}</span>)}{(item.source_commit_hash || item.target_commit_hash || item.commit_hash) && <span>根拠ハッシュ: {shortHash(item.source_commit_hash ?? item.target_commit_hash ?? item.commit_hash)}</span>}</li>)}</ul> : <p className="branch-relations-empty">この対象と検索条件に一致する未解決履歴はありません。「対象の参照を特定できない履歴も全件表示」を選ぶと全件を確認できます。</p>}</details>}
          <p className="branch-relations-coverage-note">reflog は期限切れ・削除済みになるため、過去のブランチ識別情報を完全に復元できないことがあります。取得状態が「一部取得」「未取得」の関係は、Gitの意味を補って表示していません。</p>
        </>}
      </div>
    </details>
  </section>;
}

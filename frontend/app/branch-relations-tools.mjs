// @ts-nocheck

/**
 * Pure projections for the branch/ref relation panel.  The backend owns all
 * Git interpretation.  These helpers only orient, filter, and label facts
 * that were explicitly returned by the API.
 */

const RELATION_LABELS = Object.freeze({
  equal: "同じ先端",
  ahead: "相手を含む（先行）",
  behind: "相手に含まれる（後方）",
  diverged: "分岐中",
  unrelated: "共通履歴なし",
  unknown: "比較不明",
});

const REF_KIND_LABELS = Object.freeze({
  local: "ローカル",
  remote: "リモート",
  detached: "切り離し（detached）",
});

const EVIDENCE_LABELS = Object.freeze({
  pull_request: "PRの記録",
  merge_base: "共通祖先の記録",
  reflog: "reflogの操作記録",
});

const OPERATION_LABELS = Object.freeze({
  fast_forward: "早送り（fast-forward）",
  merge: "マージ",
  branch_create: "ブランチ作成",
  pull_request: "PRの取り込み",
});

const REASON_LABELS = Object.freeze({
  ancestry_unavailable: "履歴の祖先関係を取得できませんでした。",
  merge_base_unavailable: "共通祖先を取得できませんでした。",
  no_common_ancestor: "共通祖先がありません。",
  no_common_merge_base: "共通祖先がありません。",
  shallow_history: "履歴が浅く、祖先関係を確定できません。",
  shallow_repository: "浅い履歴のため、祖先関係を確定できません。",
  history_unavailable: "履歴が取得されていません。",
  ref_unavailable: "参照先のハッシュを取得できませんでした。",
  ref_missing: "参照先が現在の一覧にありません。",
  source_ref_missing: "操作元のrefが現在の一覧にありません。",
  target_ref_missing: "操作先のrefが現在の一覧にありません。",
  source_deleted: "操作元のrefは削除済みか、現在の一覧にありません。",
  target_deleted: "操作先のrefは削除済みか、現在の一覧にありません。",
  ambiguous: "対応するrefが複数あり、特定できません。",
  source_ambiguous: "操作元のrefを一意に特定できません。",
  target_ambiguous: "操作先のrefを一意に特定できません。",
  target_branch_ambiguous: "操作先のブランチを一意に特定できません。",
  multiple_merge_bases: "共通祖先が複数あり、分岐関係を一意に確定できません。",
  multiple_pr_targets: "PRの操作先が複数あり、特定できません。",
  target_branch_not_found: "操作先ブランチが現在の一覧にありません。",
  merge_commit_unavailable: "PRのマージコミットを取得できませんでした。",
  merge_commit_ancestry_unavailable: "PRのマージコミットの祖先関係を取得できませんでした。",
  merge_commit_not_ancestor: "現在の操作先refにPRのマージコミットが含まれていません。",
  base_tip_unavailable: "比較元refの先端ハッシュを取得できませんでした。",
  shared_tip: "両方のrefが同じ先端を指しています。",
  source_and_target_are_same_row: "操作元と操作先が同じブランチ行です。",
  no_ref: "比較対象のrefがありません。",
});

/** @param {any} connection */
export function connectionRefs(connection) {
  if (!connection || !Array.isArray(connection.refs)) return [];
  return connection.refs.filter((ref) => (
    ref && typeof ref === "object" && typeof ref.id === "string" && ref.id.length > 0
    && typeof ref.name === "string"
    && ["local", "remote", "detached"].includes(ref.kind)
  ));
}

/** @param {any} connection */
export function connectionPairs(connection) {
  if (!connection || !Array.isArray(connection.pairs)) return [];
  return connection.pairs.filter((pair) => (
    pair && typeof pair === "object"
    && typeof pair.left_ref_id === "string"
    && typeof pair.right_ref_id === "string"
    && ["equal", "ahead", "behind", "diverged", "unrelated", "unknown"].includes(pair.relation)
  ));
}

/** @param {any} relation */
export function relationLabel(relation) {
  return RELATION_LABELS[relation] ?? "比較不明";
}

/** @param {any} kind */
export function refKindLabel(kind) {
  return REF_KIND_LABELS[kind] ?? "参照種別未取得";
}

/** @param {any} evidence */
export function evidenceLabel(evidence) {
  return EVIDENCE_LABELS[evidence] ?? "根拠未取得";
}

/** @param {any} operation */
export function operationLabel(operation) {
  return OPERATION_LABELS[operation] ?? "操作種別未取得";
}

/** @param {any} reason */
export function reasonLabel(reason) {
  if (!reason) return "比較根拠を取得できませんでした。";
  if (REASON_LABELS[reason]) return REASON_LABELS[reason];
  if (reason.includes("shallow") || reason.includes("浅い")) return `浅い履歴のため、祖先関係を確定できません（理由コード: ${reason}）。`;
  if (reason.includes("ambig") || reason.includes("multiple")) return `対応するrefが複数あり、特定できません（理由コード: ${reason}）。`;
  if (reason.includes("missing") || reason.includes("deleted") || reason.includes("not_found")) return `参照先が現在の一覧にありません（理由コード: ${reason}）。`;
  return `Gitの比較情報を取得できませんでした（理由コード: ${reason}）。`;
}

/** @param {any} pair @param {string} selectedRefId */
export function orientPair(pair, selectedRefId) {
  if (pair.left_ref_id !== selectedRefId && pair.right_ref_id !== selectedRefId) return null;
  const selectedIsLeft = pair.left_ref_id === selectedRefId;
  const relation = selectedIsLeft
    ? pair.relation
    : pair.relation === "ahead"
      ? "behind"
      : pair.relation === "behind"
        ? "ahead"
        : pair.relation;
  return {
    pair,
    selectedRefId,
    otherRefId: selectedIsLeft ? pair.right_ref_id : pair.left_ref_id,
    relation,
    selectedOnly: selectedIsLeft ? pair.left_only : pair.right_only,
    otherOnly: selectedIsLeft ? pair.right_only : pair.left_only,
    mergeBases: pair.merge_bases,
  };
}

/**
 * Orient every pair around one selected ref.  A missing selection intentionally
 * returns no pairs; callers can choose an explicit ref instead of implying a
 * comparison target.
 *
 * @param {Array<any>} pairs
 * @param {string|null} selectedRefId
 */
export function selectReferencePairs(pairs, selectedRefId) {
  if (!selectedRefId) return [];
  return pairs.flatMap((pair) => {
    const oriented = orientPair(pair, selectedRefId);
    return oriented ? [oriented] : [];
  });
}

/**
 * @param {ReturnType<typeof connectionRefs>} refs
 * @param {string|null} selectedRowId
 * @param {string|null} selectedLaneId
 * @param {string|null} explicitRefId
 */
export function preferredReferenceId(refs, selectedRowId = null, selectedLaneId = null, explicitRefId = null) {
  if (explicitRefId !== null) return refs.some((ref) => ref.id === explicitRefId) ? explicitRefId : null;
  const local = refs.filter((ref) => ref.kind === "local");
  const selectedLaneName = typeof selectedLaneId === "string" && selectedLaneId.startsWith("branch:")
    ? selectedLaneId.slice("branch:".length)
    : null;
  const selected = local.find((ref) => ref.id === selectedLaneId || ref.name === selectedLaneName || ref.row_id === selectedRowId);
  return selected?.id ?? local[0]?.id ?? refs.find((ref) => ref.kind === "remote")?.id ?? refs[0]?.id ?? null;
}

/**
 * Keep a manually selected ref across data refreshes, while following an
 * explicit lane/row selection when the surrounding context changes.
 *
 * @param {string|null} currentId
 * @param {string|null} preferredId
 * @param {boolean} contextChanged
 * @param {Map<string, any>} refsById
 */
export function syncSelectedReferenceId(currentId, preferredId, contextChanged, refsById) {
  return contextChanged || !currentId || !refsById.has(currentId) ? preferredId : currentId;
}

/** @param {any} ref */
export function referenceSearchText(ref) {
  return [ref.name, ref.id, ref.kind, ref.hash ?? ""].join(" ").toLocaleLowerCase();
}

/**
 * Filter a selected ref's relation list. Search is deliberately applied to
 * explicit ref names/IDs and returned facts; it never derives a Git relation.
 *
 * @param {Array<any>} orientedPairs
 * @param {Map<string, any>} refsById
 * @param {string} query
 */
export function filterReferencePairs(orientedPairs, refsById, query) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return orientedPairs;
  return orientedPairs.filter((item) => {
    const other = refsById.get(item.otherRefId);
    const haystack = [
      other?.name,
      other?.id,
      other?.kind,
      other?.hash,
      item.relation,
      relationLabel(item.relation),
      item.pair.reason,
      ...(item.mergeBases ?? []),
    ].filter(Boolean).join(" ").toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/** @param {any} edge @param {number} now */
export function connectionEventTime(edge, now = Number.POSITIVE_INFINITY) {
  if (edge.occurred_at !== null && edge.occurred_at !== undefined) {
    const operationTime = typeof edge.occurred_at === "string" ? Date.parse(edge.occurred_at) : NaN;
    return Number.isFinite(operationTime) && operationTime <= now ? operationTime : null;
  }
  if (edge.operation) return null;
  const values = [edge.target_commit?.date, edge.source_commit?.date];
  for (const value of values) {
    const time = typeof value === "string" ? Date.parse(value) : NaN;
    if (Number.isFinite(time) && time <= now) return time;
  }
  return null;
}

/**
 * Return an endpoint ref only when the backend gave its exact ref ID.  A null
 * source_ref_id/target_ref_id is an explicit indication that the identity is
 * unavailable; a row can contain both local and remote refs and therefore
 * cannot be used to infer one.
 *
 * @param {any} edge
 * @param {"source"|"target"} side
 * @param {Array<any>} refs
 */
export function edgeReferenceId(edge, side, refs) {
  const direct = side === "source" ? edge.source_ref_id : edge.target_ref_id;
  if (typeof direct === "string" && direct) return direct;
  return null;
}

/** @param {any} ref */
export function referenceDisplayName(ref) {
  if (!ref) return "参照名未取得";
  if (ref.kind === "remote" && typeof ref.id === "string" && ref.id) {
    return ref.id.replace(/^refs\/remotes\//, "") || ref.name || ref.id;
  }
  if (ref.kind === "detached" && typeof ref.id === "string" && ref.id.startsWith("detached:")) {
    return ref.id.slice("detached:".length) || ref.name || ref.id;
  }
  return ref.name || ref.id || "参照名未取得";
}

/**
 * @param {any} edge
 * @param {Array<any>} refs
 */
export function edgeReferenceIds(edge, refs) {
  return {
    source: edgeReferenceId(edge, "source", refs),
    target: edgeReferenceId(edge, "target", refs),
  };
}

/** @param {any} edge @param {Array<any>} refs */
export function edgeDisplayLabel(edge, refs) {
  const ids = edgeReferenceIds(edge, refs);
  const byId = new Map(refs.map((ref) => [ref.id, ref]));
  const sourceRef = byId.get(ids.source);
  const targetRef = byId.get(ids.target);
  const source = sourceRef ? `${referenceDisplayName(sourceRef)}（${refKindLabel(sourceRef.kind)}）` : edge.source || "操作元参照未取得";
  const target = targetRef ? `${referenceDisplayName(targetRef)}（${refKindLabel(targetRef.kind)}）` : edge.target || "操作先参照未取得";
  return `${source} → ${target}`;
}

/** @param {any} connection */
export function coverageLabels(connection) {
  const ancestry = connection?.ancestry_status;
  const reflog = connection?.reflog_status;
  return {
    ancestry: ancestry === "complete" ? "祖先関係: 取得済み" : ancestry === "partial" ? "祖先関係: 一部取得" : ancestry === "shallow" ? "祖先関係: 浅い履歴" : "祖先関係: 未取得",
    reflog: reflog === "available" ? "reflog: 取得済み" : reflog === "partial" ? "reflog: 一部取得" : reflog === "unavailable" ? "reflog: 未取得" : "reflog: 未取得",
    ancestryClass: ancestry === "complete" ? "is-complete" : ancestry === "partial" || ancestry === "shallow" ? "is-partial" : "is-unavailable",
    reflogClass: reflog === "available" ? "is-complete" : reflog === "partial" ? "is-partial" : "is-unavailable",
  };
}

/** @param {any} connection */
export function unresolvedItems(connection) {
  return Array.isArray(connection?.unresolved) ? connection.unresolved : [];
}

/** @param {any} connection */
export function relationCounts(connection) {
  const pairs = connectionPairs(connection);
  return pairs.reduce((counts, pair) => ({ ...counts, [pair.relation]: counts[pair.relation] + 1 }), {
    equal: 0,
    ahead: 0,
    behind: 0,
    diverged: 0,
    unrelated: 0,
    unknown: 0,
  });
}

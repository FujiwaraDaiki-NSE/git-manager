// @ts-nocheck

import {
  edgeReferenceIds,
  evidenceLabel,
  operationLabel,
  refKindLabel,
  referenceDisplayName,
  relationLabel,
} from "./branch-relations-tools.mjs";

const RELATION_ORDER = Object.freeze({
  equal: 0,
  ahead: 1,
  behind: 2,
  diverged: 3,
  unrelated: 4,
  unknown: 5,
});

const SORT_KEYS = new Set(["name", "relation", "divergence"]);

function lower(value) {
  return String(value ?? "").toLocaleLowerCase();
}

function requiredFilter(value, name) {
  if (value === null) return "";
  if (typeof value !== "string") throw new TypeError(`${name} must be an explicit string or null`);
  return value;
}

function requiredRows(value) {
  if (!Array.isArray(value)) throw new TypeError("rows must be an explicit array");
  return value;
}

function numeric(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function divergenceScore(item) {
  const selectedOnly = numeric(item.selectedOnly);
  const otherOnly = numeric(item.otherOnly);
  return selectedOnly === null || otherOnly === null ? Number.POSITIVE_INFINITY : selectedOnly + otherOnly;
}

function pairSearchText(item, refsById) {
  const other = refsById.get(item.otherRefId);
  return [
    other?.name,
    other?.id,
    other?.kind,
    other?.hash,
    item.relation,
    relationLabel(item.relation),
    item.pair?.reason,
    ...(item.mergeBases ?? []),
  ].filter(Boolean).join(" ");
}

/**
 * Apply exact relation and other-ref-kind filters before the free-text search.
 * The API's oriented pair facts remain unchanged; this only chooses visible rows.
 */
export function filterVisibleReferencePairs(items, refsById, options) {
  if (!options || typeof options !== "object") throw new TypeError("pair filters are required");
  const query = requiredFilter(options.query, "query");
  const relation = requiredFilter(options.relation, "relation");
  const otherKind = requiredFilter(options.otherKind, "otherKind");
  const terms = lower(query).trim().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    if (relation && item.relation !== relation) return false;
    const other = refsById.get(item.otherRefId);
    if (otherKind && other?.kind !== otherKind) return false;
    if (!terms.length) return true;
    const haystack = lower(pairSearchText(item, refsById));
    return terms.every((term) => haystack.includes(term));
  });
}

/**
 * Sort visible pair rows deterministically. Ties use the other ref ID so a
 * refresh cannot reorder otherwise identical rows.
 */
export function sortVisibleReferencePairs(items, refsById, sortKey) {
  if (!SORT_KEYS.has(sortKey)) throw new RangeError(`Unsupported pair sort: ${sortKey}`);
  const key = sortKey;
  return items.map((item, index) => ({ item, index })).sort((left, right) => {
    const a = left.item;
    const b = right.item;
    const aRef = refsById.get(a.otherRefId);
    const bRef = refsById.get(b.otherRefId);
    const nameCompare = lower(referenceDisplayName(aRef)).localeCompare(lower(referenceDisplayName(bRef)), "ja");
    const relationCompare = (RELATION_ORDER[a.relation] ?? Number.MAX_SAFE_INTEGER) - (RELATION_ORDER[b.relation] ?? Number.MAX_SAFE_INTEGER);
    const divergenceCompare = divergenceScore(a) - divergenceScore(b);
    const ordered = key === "relation"
      ? relationCompare || nameCompare || divergenceCompare
      : key === "divergence"
        ? divergenceCompare || nameCompare || relationCompare
        : nameCompare || relationCompare || divergenceCompare;
    if (ordered !== 0 && !Number.isNaN(ordered)) return ordered;
    const idCompare = String(a.otherRefId).localeCompare(String(b.otherRefId));
    return idCompare || left.index - right.index;
  }).map(({ item }) => item);
}

/**
 * Filter historical edges by exact evidence/operation values and searchable
 * text. A missing filter means “all values”, while an unknown API value stays
 * searchable and is never reclassified by this helper.
 */
export function filterHistoricalEdges(edges, refs, selectedRefId, options) {
  if (!options || typeof options !== "object") throw new TypeError("historical filters are required");
  const query = requiredFilter(options.query, "query");
  const evidence = requiredFilter(options.evidence, "evidence");
  const operation = requiredFilter(options.operation, "operation");
  const rows = requiredRows(options.rows);
  if (selectedRefId !== null && typeof selectedRefId !== "string") throw new TypeError("selectedRefId must be an explicit string or null");
  const terms = lower(query).trim().split(/\s+/).filter(Boolean);
  const refsById = new Map(refs.map((ref) => [ref.id, ref]));
  const rowsById = new Map(rows.map((row) => [row.id, row.name]));
  return edges.filter((edge) => {
    const ids = edgeReferenceIds(edge, refs);
    if (selectedRefId && ids.source !== selectedRefId && ids.target !== selectedRefId) return false;
    if (evidence && edge.evidence !== evidence) return false;
    if (operation && edge.operation !== operation) return false;
    if (!terms.length) return true;
    const sourceRef = refsById.get(ids.source);
    const targetRef = refsById.get(ids.target);
    const haystack = lower([
      edge.label,
      edge.evidence,
      evidenceLabel(edge.evidence),
      edge.operation,
      operationLabel(edge.operation),
      edge.source,
      edge.target,
      sourceRef && referenceDisplayName(sourceRef),
      targetRef && referenceDisplayName(targetRef),
      edge.source_row_id,
      edge.target_row_id,
      rowsById.get(edge.source_row_id),
      rowsById.get(edge.target_row_id),
      edge.commit_hash,
      edge.source_commit_hash,
      edge.target_commit_hash,
      edge.pr_number === null || edge.pr_number === undefined ? "" : `pr ${edge.pr_number}`,
    ].filter(Boolean).join(" "));
    return terms.every((term) => haystack.includes(term));
  });
}

function exportPair(item, refsById) {
  const other = refsById.get(item.otherRefId);
  return {
    other_ref: other ? {
      id: other.id,
      name: referenceDisplayName(other),
      kind: other.kind,
      hash: other.hash,
    } : null,
    relation: item.relation,
    selected_only: item.selectedOnly,
    other_only: item.otherOnly,
    merge_bases: item.mergeBases,
    reason: item.pair?.reason ?? null,
  };
}

/** Create a self-contained JSON document for the currently visible pairs. */
export function visiblePairsJson({ repository, selectedRef, coverage, filters, pairs, refsById }) {
  return JSON.stringify({
    repository,
    ref: selectedRef ? {
      id: selectedRef.id,
      name: referenceDisplayName(selectedRef),
      kind: selectedRef.kind,
      hash: selectedRef.hash,
    } : null,
    coverage,
    filters,
    pairs: pairs.map((item) => exportPair(item, refsById)),
  }, null, 2);
}

/** Create Markdown containing exactly the pair rows currently shown. */
export function visiblePairsMarkdown({ repository, selectedRef, coverage, filters, pairs, refsById }) {
  const markdownCell = (value) => String(value ?? "").replaceAll("|", "\\|").replace(/[\r\n]+/g, " ").replaceAll("`", "\\`");
  const refLabel = selectedRef ? `${referenceDisplayName(selectedRef)}（${refKindLabel(selectedRef.kind)}）` : "参照未選択";
  const selectedHash = selectedRef?.hash ? ` \`${selectedRef.hash}\`` : "（ハッシュ未取得）";
  const lines = [
    `# Git 関係比較: ${markdownCell(refLabel)}${selectedHash}`,
    `- リポジトリ: ${markdownCell(repository)}`,
    `- 祖先関係: ${coverage.ancestry}`,
    `- reflog: ${coverage.reflog}`,
    `- フィルター: ${JSON.stringify(filters)}`,
    "",
    `| 相手の参照 | 関係 | この参照のみ | 相手のみ | 共通祖先 | 根拠 |`,
    "| --- | --- | ---: | ---: | --- | --- |",
  ];
  for (const item of pairs) {
    const other = refsById.get(item.otherRefId);
    const otherLabel = other ? `${markdownCell(referenceDisplayName(other))}（${refKindLabel(other.kind)}）${other.hash ? ` \`${other.hash}\`` : "（ハッシュ未取得）"}` : `参照未取得（${markdownCell(item.otherRefId)}）`;
    const selectedOnly = item.selectedOnly === null || item.selectedOnly === undefined ? "未取得" : item.selectedOnly;
    const otherOnly = item.otherOnly === null || item.otherOnly === undefined ? "未取得" : item.otherOnly;
    const bases = item.mergeBases === null ? "未取得" : item.mergeBases.length ? item.mergeBases.map((hash) => `\`${markdownCell(hash)}\``).join(", ") : "なし";
    const reason = item.pair?.reason ? `(${markdownCell(item.pair.reason)})` : (item.relation === "unknown" || item.mergeBases === null || selectedOnly === "未取得" || otherOnly === "未取得" ? "未取得" : "取得済み");
    lines.push(`| ${otherLabel} | ${markdownCell(relationLabel(item.relation))} | ${selectedOnly} | ${otherOnly} | ${bases} | ${reason} |`);
  }
  if (!pairs.length) lines.push("| （表示できるペアなし） | | | | | | ");
  return `${lines.join("\n")}\n`;
}

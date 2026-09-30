// @ts-check

/**
 * Keep the relation projection independent from DOM measurement. The React
 * layer supplies row positions after layout; these helpers decide which
 * relations are in focus and which path should point to which row.
 *
 * @typedef {{id:string, kind:'merge'|'branch', source_row_id:string, target_row_id:string, evidence:'pull_request'|'merge_base', commit_hash:string|null, pr_number:number|null, pr_url:string|null, label:string}} BranchConnectionEdge
 * @typedef {{id:string, kind:'merge'|'branch', source_row_id:string|null, target_row_id:string|null, source:string, target:string, reason:string, pr_number:number|null, pr_url:string|null}} BranchConnectionUnresolved
 * @typedef {{id:string, y:number, x:number}} ConnectionAnchor
 */

/**
 * A focused relation set contains both the visible edges and the edges whose
 * counterpart is hidden by the current view. Hidden edges remain in the
 * accessible relation list so filtering cannot imply that a relation ceased
 * to exist.
 *
 * @param {BranchConnectionEdge[]} edges
 * @param {string|null} focusRowId
 * @param {Set<string>} visibleRowIds
 */
export function selectBranchConnections(edges, focusRowId, visibleRowIds) {
  const focused = focusRowId
    ? edges.filter((edge) => edge.source_row_id === focusRowId || edge.target_row_id === focusRowId)
    : [];
  const visible = focused.filter(
    (edge) => visibleRowIds.has(edge.source_row_id) && visibleRowIds.has(edge.target_row_id),
  );
  const offscreen = focused.filter((edge) => !visible.includes(edge));
  const relatedRowIds = new Set();
  focused.forEach((edge) => {
    relatedRowIds.add(edge.source_row_id);
    relatedRowIds.add(edge.target_row_id);
  });
  return { focused, visible, offscreen, relatedRowIds };
}

/**
 * Build the narrow left-gutter paths used by the SVG overlay. A path always
 * begins at the source row and ends at the target row, even when the target
 * appears above the source in the current sort order.
 *
 * @param {BranchConnectionEdge[]} edges
 * @param {Map<string, ConnectionAnchor>} anchors
 */
export function buildBranchConnectionPaths(edges, anchors) {
  // Both ends terminate at the card boundary. The narrow curve bends into
  // the gutter, so direction remains readable even when the target sorts
  // above the source.
  return edges.flatMap((edge) => {
    const source = anchors.get(edge.source_row_id);
    const target = anchors.get(edge.target_row_id);
    if (!source || !target) return [];
    if (!Number.isFinite(source.x) || !Number.isFinite(target.x) || !Number.isFinite(source.y) || !Number.isFinite(target.y)) return [];
    const startX = source.x;
    const endX = target.x;
    const bendX = Math.max(8, Math.min(startX, endX) - 12);
    return [{
      ...edge,
      sourceY: source.y,
      targetY: target.y,
      d: `M ${startX} ${source.y} C ${bendX} ${source.y}, ${bendX} ${target.y}, ${endX} ${target.y}`,
    }];
  });
}

/** @param {BranchConnectionEdge} edge */
export function branchConnectionEvidenceLabel(edge) {
  if (edge.evidence === "pull_request") return "実際のPRマージ";
  return "分岐の推定（共通祖先）";
}

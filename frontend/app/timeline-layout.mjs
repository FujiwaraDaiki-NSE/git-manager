// Timeline layout decisions stay pure so that the graph can be checked without
// rendering React or consulting the current browser state.

const TIMELINE_STUB_ROW_DISTANCE = 4;
const TIMELINE_STUB_LENGTH = 24;

function updatedAt(row) {
  return Math.max(-Infinity, ...row.tip_commits.map((commit) => Date.parse(commit.date)).filter(Number.isFinite));
}

function connectionTime(edge) {
  const time = typeof edge.occurred_at === "string" ? Date.parse(edge.occurred_at) : NaN;
  return Number.isFinite(time) ? time : null;
}

function isRecordedConnection(edge) {
  return typeof edge.evidence === "string" && edge.evidence !== "merge_base";
}

function compareConnectionCandidates(left, right) {
  const leftRecorded = isRecordedConnection(left);
  const rightRecorded = isRecordedConnection(right);
  if (leftRecorded !== rightRecorded) return leftRecorded ? -1 : 1;
  const leftTime = connectionTime(left);
  const rightTime = connectionTime(right);
  if ((leftTime === null) !== (rightTime === null)) return leftTime === null ? 1 : -1;
  if (leftTime !== null && rightTime !== null && rightTime !== leftTime) return rightTime - leftTime;
  return String(left.id).localeCompare(String(right.id));
}

function sortUpdatedRows(rows) {
  return [...rows].sort((left, right) => updatedAt(right) - updatedAt(left) || left.id.localeCompare(right.id));
}

/**
 * Order a selected set of rows without changing which rows were selected.
 * Branch edges point from the parent row (`source`) to the child row
 * (`target`). An edge with operation evidence wins over merge-base evidence;
 * cycles are skipped while traversing.
 *
 * @param {Array<any>} rows
 * @param {string|null} defaultBranch
 * @param {Array<any>} connections
 * @param {"parent"|"updated"} order
 */
export function sortTimelineRows(rows, defaultBranch, connections, order) {
  const updated = sortUpdatedRows(rows);
  const defaults = updated.filter((row) => !row.historical && row.name === defaultBranch);
  const defaultIds = new Set(defaults.map((row) => row.id));
  const others = updated.filter((row) => !defaultIds.has(row.id));
  if (order === "updated") return [...defaults, ...others];

  const byId = new Map(rows.map((row) => [row.id, row]));
  const parentByChild = new Map();
  const branchCandidates = new Map();
  for (const edge of connections) {
    if (
      edge?.kind !== "branch"
      || typeof edge.source_row_id !== "string"
      || typeof edge.target_row_id !== "string"
      || !byId.has(edge.source_row_id)
      || !byId.has(edge.target_row_id)
    ) continue;
    const candidates = branchCandidates.get(edge.target_row_id) ?? [];
    candidates.push(edge);
    branchCandidates.set(edge.target_row_id, candidates);
  }
  for (const [childId, candidates] of branchCandidates) {
    const ordered = [...candidates].sort(compareConnectionCandidates);
    parentByChild.set(childId, ordered[0].source_row_id);
  }

  const childrenByParent = new Map();
  for (const [childId, parentId] of parentByChild) {
    if (!byId.has(parentId)) continue;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(childId);
    childrenByParent.set(parentId, children);
  }
  for (const children of childrenByParent.values()) {
    children.sort((left, right) => updatedAt(byId.get(right)) - updatedAt(byId.get(left)) || left.localeCompare(right));
  }

  const orderedRows = [];
  const visited = new Set();
  const visit = (rowId) => {
    if (visited.has(rowId) || !byId.has(rowId)) return;
    visited.add(rowId);
    orderedRows.push(byId.get(rowId));
    for (const childId of childrenByParent.get(rowId) ?? []) visit(childId);
  };

  // The default branch is always the first root, even if malformed data gives
  // it a parent edge. Rows whose parent is absent from this selected window
  // are the unknown-parent roots and are intentionally visited last.
  for (const row of defaults) visit(row.id);
  const unknownParents = others.filter((row) => !parentByChild.has(row.id));
  for (const row of unknownParents) visit(row.id);
  for (const row of others) visit(row.id);
  return orderedRows;
}

// Selection uses commit dates from the current branch tips, never scan timestamps.
// The limit is applied to the newest eligible rows before the selected set is
// ordered for display.
export function selectTimelineRows(rows, defaultBranch, limit, showMerged, order, connections) {
  const eligible = rows.filter((row) => showMerged || !row.historical);
  const updated = sortUpdatedRows(eligible);
  const defaults = updated.filter((row) => !row.historical && row.name === defaultBranch);
  const defaultIds = new Set(defaults.map((row) => row.id));
  const others = updated.filter((row) => !defaultIds.has(row.id));
  const selected = [...defaults, ...(limit === null ? others : others.slice(0, limit))];
  return { rows: sortTimelineRows(selected, defaultBranch, connections, order), total: eligible.length };
}

/**
 * Keep the complete relation set separate from the edges drawable in the
 * current row window. A hidden endpoint is a view limitation, not evidence
 * that the relation disappeared.
 *
 * @param {Array<{source_row_id?: string|null, target_row_id?: string|null}>} edges
 * @param {Set<string>} visibleRowIds
 */
export function selectTimelineConnectionEdges(edges, visibleRowIds) {
  const visible = edges.filter((edge) => (
    typeof edge.source_row_id === "string"
    && typeof edge.target_row_id === "string"
    && visibleRowIds.has(edge.source_row_id)
    && visibleRowIds.has(edge.target_row_id)
  ));
  const drawable = new Set(visible);
  return {
    visible,
    hidden: edges.filter((edge) => !drawable.has(edge)),
    total: edges.length,
  };
}

/**
 * Select the quiet default relation set. A row can contribute at most one
 * branch origin (where it is the target) and one merge destination (where it
 * is the source). Recorded operations win; a merge-base edge is admitted for
 * a branch origin only when it is that row's sole candidate.
 *
 * @param {Array<any>} edges
 */
export function selectDefaultTimelineConnectionEdges(edges) {
  const branchByTarget = new Map();
  const mergeBySource = new Map();
  for (const edge of edges) {
    if (
      typeof edge.source_row_id !== "string"
      || typeof edge.target_row_id !== "string"
      || edge.source_row_id === edge.target_row_id
    ) continue;
    if (edge.kind === "branch") {
      const candidates = branchByTarget.get(edge.target_row_id) ?? [];
      candidates.push(edge);
      branchByTarget.set(edge.target_row_id, candidates);
    } else if (edge.kind === "merge") {
      const candidates = mergeBySource.get(edge.source_row_id) ?? [];
      candidates.push(edge);
      mergeBySource.set(edge.source_row_id, candidates);
    }
  }

  const selected = new Set();
  for (const candidates of branchByTarget.values()) {
    const recorded = candidates.filter(isRecordedConnection).sort(compareConnectionCandidates);
    const chosen = recorded[0] ?? (candidates.length === 1 && candidates[0].evidence === "merge_base" ? candidates[0] : null);
    if (chosen) selected.add(chosen.id);
  }
  for (const candidates of mergeBySource.values()) {
    const chosen = candidates.filter(isRecordedConnection).sort(compareConnectionCandidates)[0];
    if (chosen) selected.add(chosen.id);
  }
  return edges.filter((edge) => selected.has(edge.id));
}

/**
 * Resolve the graph treatment for one relation. Far non-default relations are
 * hidden until a row, relation, or all-lines mode gives them an explicit
 * context. Reversed relations only expose endpoint markers in that context.
 *
 * @param {any} route
 * @param {{showAll: boolean, focusedRouteId: string|null, activeRowIds: Set<string>}} options
 * @returns {"hidden"|"stub"|"full"|"marker"}
 */
export function timelineConnectionDisplay(route, options) {
  const contextual = options.showAll
    || options.focusedRouteId === route.id
    || options.activeRowIds.has(route.sourceRowId)
    || options.activeRowIds.has(route.targetRowId);
  if (contextual) return route.drawn ? "full" : "marker";
  if (!route.defaultVisible || !route.drawn) return "hidden";
  return route.stub ? "stub" : "full";
}

export function isTimelineConnectionStub(rowDistance) {
  if (!Number.isFinite(rowDistance)) throw new TypeError("rowDistance must be a finite number");
  return Math.abs(rowDistance) >= TIMELINE_STUB_ROW_DISTANCE;
}

/**
 * Collapse far-relation chip candidates by row and endpoint side. A group
 * with more than one stable candidate is represented by one aggregate chip.
 * Candidates revealed only by a transient row/selection state are ignored.
 *
 * @param {Array<any>} chips
 */
export function aggregateTimelineConnectionChips(chips) {
  const stableCandidates = chips.filter((chip) => chip.defaultVisible === true && chip.stub === true);
  const groups = new Map();
  for (const chip of stableCandidates) {
    const key = `${chip.rowId}:${chip.side}`;
    const group = groups.get(key) ?? [];
    group.push(chip);
    groups.set(key, group);
  }

  const output = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) => (left.left ?? 0) - (right.left ?? 0) || String(left.routeId).localeCompare(String(right.routeId)));
    if (ordered.length > 1) {
      output.push({
        type: "aggregate",
        id: `aggregate:${ordered[0].rowId}:${ordered[0].side}`,
        rowId: ordered[0].rowId,
        rowIndex: ordered[0].rowIndex,
        side: ordered[0].side,
        routeIds: ordered.map((chip) => chip.routeId),
        count: ordered.length,
        kind: ordered.every((chip) => chip.kind === ordered[0].kind) ? ordered[0].kind : "mixed",
        glyph: ordered.every((chip) => chip.glyph === ordered[0].glyph) ? ordered[0].glyph : ordered[0].side === "source" ? "↘" : "↙",
        label: aggregateTimelineConnectionChipLabel(stableCandidates, ordered[0].rowId, ordered[0].side),
        left: ordered[0].left,
        width: ordered[0].width,
      });
    } else {
      output.push({ type: "single", ...ordered[0], routeIds: [ordered[0].routeId], count: 1 });
    }
  }
  return output;
}

/**
 * Build the label for one row-side aggregate from the stable default-visible
 * far relations only. Presentation state is intentionally not part of this
 * calculation, so hovering, pinning, or selecting a row cannot change it.
 *
 * @param {Array<any>} chips
 * @param {string} rowId
 * @param {"source"|"target"} side
 */
export function aggregateTimelineConnectionChipLabel(chips, rowId, side) {
  const candidates = chips.filter((chip) => (
    chip.rowId === rowId
    && chip.side === side
    && chip.defaultVisible === true
    && chip.stub === true
  ));
  if (candidates.length === 0) return null;
  const kind = candidates.every((chip) => chip.kind === candidates[0].kind) ? candidates[0].kind : "mixed";
  const glyph = candidates.every((chip) => chip.glyph === candidates[0].glyph)
    ? candidates[0].glyph
    : side === "source" ? "↘" : "↙";
  const relation = kind === "mixed"
    ? "関係"
    : kind === "merge"
      ? side === "source" ? "マージ先" : "マージ元"
      : side === "source" ? "分岐先" : "分岐元";
  return `${glyph} ${candidates.length}件の${relation}`;
}

/**
 * Build an S-shaped relation path. Every x coordinate in a normal path is
 * non-decreasing. Reversed timestamps intentionally produce no path at all;
 * the caller can still render the returned endpoint marker coordinates and
 * explain the anomaly in the relation title.
 *
 * @param {Array<any>} connections
 */
export function routeTimelineConnections(connections) {
  return connections.map((connection) => {
    const { x1, x2, y1, y2 } = connection;
    const isStub = isTimelineConnectionStub(connection.rowDistance);
    if (x1 > x2) {
      return {
        ...connection,
        path: null,
        arrow: null,
        sourceStubPath: null,
        targetStubPath: null,
        reversed: true,
        drawn: false,
        stub: false,
        reason: "接続先の時刻が接続元より過去のため、時間を逆走する線を描画していません。",
      };
    }

    const midpoint = (x1 + x2) / 2;
    const direction = y2 > y1 ? 1 : y2 < y1 ? -1 : 0;
    const arrow = direction === 0
      ? null
      : `M ${x2 - 5} ${y2 - direction * 8} L ${x2} ${y2} L ${x2 + 5} ${y2 - direction * 8} Z`;
    const sourceStubEnd = Math.min(x1 + TIMELINE_STUB_LENGTH, x2);
    const targetStubStart = Math.max(x2 - TIMELINE_STUB_LENGTH, x1);
    return {
      ...connection,
      path: `M ${x1} ${y1} C ${midpoint} ${y1}, ${midpoint} ${y2}, ${x2} ${y2}`,
      arrow,
      sourceStubPath: isStub ? `M ${x1} ${y1} H ${sourceStubEnd}` : null,
      targetStubPath: isStub ? `M ${targetStubStart} ${y2} H ${x2}` : null,
      reversed: false,
      drawn: true,
      stub: isStub,
      reason: null,
    };
  });
}

/**
 * Group laid-out events without copying each growing lane on every insert.
 * Full-history views can contain tens of thousands of events in one row, so
 * repeatedly spreading the existing array turns a linear grouping step into
 * quadratic work.
 *
 * @param {Array<{lane: {id: string}}>} events
 */
export function groupTimelineEventsByRow(events) {
  const grouped = new Map();
  for (const event of events) {
    const current = grouped.get(event.lane.id);
    if (current) current.push(event);
    else grouped.set(event.lane.id, [event]);
  }
  return grouped;
}

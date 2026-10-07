// Selection uses commit dates from the current branch tips, never scan timestamps.
export function selectTimelineRows(rows, defaultBranch, limit, showMerged) {
  const eligible = rows.filter(row => showMerged || !row.historical);
  const updated = row => Math.max(-Infinity, ...row.tip_commits.map(commit => Date.parse(commit.date)).filter(Number.isFinite));
  const ordered = [...eligible].sort((a, b) => updated(b) - updated(a) || a.id.localeCompare(b.id));
  const defaults = ordered.filter(row => !row.historical && row.name === defaultBranch);
  const others = ordered.filter(row => !defaults.includes(row));
  return { rows: [...defaults, ...(limit === null ? others : others.slice(0, limit))], total: eligible.length };
}

/**
 * Keep the complete relation set separate from the edges drawable in the
 * current row window.  A hidden endpoint is a view limitation, not evidence
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

// Route through separate vertical channels. Horizontal legs sit away from commit
// centers; the final segment points into the actual rendered destination dot.
export function routeTimelineConnections(connections, points, width) {
  // Connection routing used to walk every commit point for every route.  A
  // full history can contain tens of thousands of points while the number of
  // connection routes stays small.  Index the points by their rendered row
  // first, then answer each route's vertical interval from prefix sums.  The
  // score is intentionally the same as the old point-by-point loop: a point
  // contributes 100000 to each nearby channel.
  const candidatesCount = Math.max(0, Math.floor((width - 12) / 16) + 1);
  const pointRows = new Map();
  for (const point of points) {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) continue;
    let row = pointRows.get(point.y);
    if (!row) {
      row = new Map();
      pointRows.set(point.y, row);
    }
    const nearest = Math.round((point.x - 12) / 16);
    for (let index = nearest - 1; index <= nearest + 1; index += 1) {
      const candidateX = 12 + index * 16;
      if (index >= 0 && index < candidatesCount && Math.abs(candidateX - point.x) < 12) row.set(index, (row.get(index) ?? 0) + 100000);
    }
  }
  const pointY = [...pointRows.keys()].sort((left, right) => left - right);
  // Keep the prefix index bounded when a caller supplies an unusually wide
  // track.  The sparse fallback below still visits only occupied channels.
  const usePointPrefix = candidatesCount * pointY.length <= 2_000_000;
  const pointCosts = usePointPrefix ? Array.from({ length: candidatesCount }, () => new Float64Array(pointY.length + 1)) : null;
  if (pointCosts) pointY.forEach((y, rowIndex) => {
    const row = pointRows.get(y);
    for (let index = 0; index < candidatesCount; index += 1) pointCosts[index][rowIndex + 1] = pointCosts[index][rowIndex] + (row?.get(index) ?? 0);
  });
  const firstGreater = (values, target) => {
    let low = 0;
    let high = values.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (values[middle] > target) high = middle;
      else low = middle + 1;
    }
    return low;
  };
  const firstAtLeast = (values, target) => {
    let low = 0;
    let high = values.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (values[middle] >= target) high = middle;
      else low = middle + 1;
    }
    return low;
  };
  const occupied = [];
  const horizontal = [];
  const placeLeg = (rowY, direction, start, end) => {
    const left = Math.min(start, end) - 6;
    const right = Math.max(start, end) + 6;
    const options = [20, 28, 36].map(offset => {
      const y = rowY + direction * offset;
      const overlaps = horizontal.filter(leg => leg.y === y && leg.left < right && leg.right > left).length;
      return { y, overlaps };
    });
    const best = options.reduce((best, option) => option.overlaps < best.overlaps ? option : best);
    horizontal.push({ y: best.y, left, right });
    return best;
  };
  return connections.map(connection => {
    const { x1, x2, y1, y2 } = connection;
    const direction = Math.sign(y2 - y1);
    const low = Math.min(y1, y2), high = Math.max(y1, y2);
    const midpoint = (x1 + x2) / 2;
    const candidates = [];
    for (let index = 0; index < candidatesCount; index += 1) candidates.push({ x: 12 + index * 16, cost: Math.abs(12 + index * 16 - midpoint) });
    const addCost = (x, cost) => {
      const nearest = Math.round((x - 12) / 16);
      for (let index = nearest - 1; index <= nearest + 1; index += 1) {
        const candidate = candidates[index];
        if (candidate && Math.abs(candidate.x - x) < 12) candidate.cost += cost;
      }
    };
    const firstRow = firstGreater(pointY, low);
    const lastRow = firstAtLeast(pointY, high);
    if (lastRow > firstRow && pointCosts) {
      for (let index = 0; index < candidates.length; index += 1) {
        candidates[index].cost += pointCosts[index][lastRow] - pointCosts[index][firstRow];
      }
    } else if (lastRow > firstRow) {
      for (let rowIndex = firstRow; rowIndex < lastRow; rowIndex += 1) {
        for (const [index, cost] of pointRows.get(pointY[rowIndex]) ?? []) candidates[index].cost += cost;
      }
    }
    for (const route of occupied) if (route.low < high && route.high > low) addCost(route.x, 10000);
    const channel = candidates.reduce((best, candidate) => candidate.cost < best.cost ? candidate : best).x;
    occupied.push({ x: channel, low, high });
    const from = placeLeg(y1, direction, x1, channel);
    const to = placeLeg(y2, -direction, channel, x2);
    // Stop outside the commit dot: its HTML hit target otherwise hides the arrow.
    const arrowY = y2 - direction * 12;
    const sourceY = y1 + direction * 12;
    return { ...connection, channel, fromY: from.y, toY: to.y, sourceY, arrowY,
      crowded: from.overlaps > 0 || to.overlaps > 0,
      path: `M ${x1} ${sourceY} V ${from.y} H ${channel} V ${to.y} H ${x2} V ${arrowY}`,
      arrow: `M ${x2 - 5} ${arrowY - direction * 8} L ${x2} ${arrowY} L ${x2 + 5} ${arrowY - direction * 8} Z`,
    };
  });
}

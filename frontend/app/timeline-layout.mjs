// Selection uses commit dates from the current branch tips, never scan timestamps.
export function selectTimelineRows(rows, defaultBranch, limit, showMerged) {
  const eligible = rows.filter(row => showMerged || !row.historical);
  const updated = row => Math.max(-Infinity, ...row.tip_commits.map(commit => Date.parse(commit.date)).filter(Number.isFinite));
  const ordered = [...eligible].sort((a, b) => updated(b) - updated(a) || a.id.localeCompare(b.id));
  const defaults = ordered.filter(row => !row.historical && row.name === defaultBranch);
  const others = ordered.filter(row => !defaults.includes(row));
  return { rows: [...defaults, ...(limit === null ? others : others.slice(0, limit))], total: eligible.length };
}

// Route through separate vertical channels. Horizontal legs sit away from commit
// centers; the final segment points into the actual rendered destination dot.
export function routeTimelineConnections(connections, points, width) {
  const occupied = [];
  return connections.map(connection => {
    const { x1, x2, y1, y2 } = connection;
    const direction = Math.sign(y2 - y1);
    const fromY = y1 + direction * 20;
    const toY = y2 - direction * 20;
    const low = Math.min(y1, y2), high = Math.max(y1, y2);
    const midpoint = (x1 + x2) / 2;
    const candidates = [];
    for (let x = 12; x <= width - 12; x += 16) candidates.push({ x, cost: Math.abs(x - midpoint) });
    const addCost = (x, cost) => {
      const nearest = Math.round((x - 12) / 16);
      for (let index = nearest - 1; index <= nearest + 1; index += 1) {
        const candidate = candidates[index];
        if (candidate && Math.abs(candidate.x - x) < 12) candidate.cost += cost;
      }
    };
    for (const point of points) if (point.y > low && point.y < high) addCost(point.x, 100000);
    for (const route of occupied) if (route.low < high && route.high > low) addCost(route.x, 10000);
    const channel = candidates.reduce((best, candidate) => candidate.cost < best.cost ? candidate : best).x;
    occupied.push({ x: channel, low, high });
    return { ...connection, channel,
      path: `M ${x1} ${y1} V ${fromY} H ${channel} V ${toY} H ${x2} V ${y2}`,
      arrow: `M ${x2 - 4} ${y2 - direction * 7} L ${x2} ${y2} L ${x2 + 4} ${y2 - direction * 7}`,
    };
  });
}

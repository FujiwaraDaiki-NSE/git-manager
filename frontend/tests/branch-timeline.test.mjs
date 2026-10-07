import test from "node:test";
import assert from "node:assert/strict";
import {
  eventLeaderGeometry,
  graphTimeTicks,
  layoutFlowEvents,
  recentTimeAt,
  recentTimePosition,
} from "../app/project-flow.mjs";

test("timeline time scale round trips the non-linear observation point", () => {
  const min = Date.parse("2026-01-01T00:00:00Z");
  const max = Date.parse("2026-01-08T00:00:00Z");
  for (const position of [0, 17, 50, 83, 100]) {
    const time = recentTimeAt(position, min, max);
    assert.ok(Math.abs(recentTimePosition(time, min, max) - position) < 1e-8);
  }
});

test("timeline event layout preserves chronological order and gives displaced dots a leader", () => {
  const events = [
    { row: { hash: "older", date: "2026-01-01T00:00:00Z" }, x: 5 },
    { row: { hash: "newer", date: "2026-01-01T00:00:01Z" }, x: 6 },
  ];
  const laidOut = layoutFlowEvents(events, 440);
  assert.deepEqual(laidOut.map((event) => event.row.hash), ["older", "newer"]);
  assert.ok(laidOut[1].hitX - laidOut[0].hitX >= 10);
  const leader = eventLeaderGeometry(6, laidOut[1].hitX, 440);
  assert.ok(leader.width > 0);
});

test("timeline ticks include both bounded endpoints", () => {
  const ticks = graphTimeTicks(Date.parse("2026-01-01T00:00:00Z"), Date.parse("2026-01-02T00:00:00Z"), 440);
  assert.equal(ticks[0].edge, "start");
  assert.equal(ticks.at(-1).edge, "end");
  assert.equal(ticks[0].position, 0);
  assert.equal(ticks.at(-1).position, 100);
});

import {
  aggregateTimelineConnectionChipLabel,
  aggregateTimelineConnectionChips,
  groupTimelineEventsByRow,
  isTimelineConnectionStub,
  routeTimelineConnections,
  selectDefaultTimelineConnectionEdges,
  selectTimelineConnectionEdges,
  selectTimelineRows,
  sortTimelineRows,
  timelineConnectionDisplay,
} from '../app/timeline-layout.mjs';

test('recent branch limit keeps the default branch and sorts by tip date, with unknown dates last', () => {
  const row = (id, date, historical = false) => ({id, name: id, historical, tip_commits: [{date}]});
  const rows = [row('main', '2020-01-01'), row('old', '2024-01-01'), row('unknown', null), row('new', '2026-01-01'), row('deleted', '2027-01-01', true)];
  assert.deepEqual(selectTimelineRows(rows, 'main', 1, false, 'parent', []).rows.map(r => r.id), ['main', 'new']);
  assert.deepEqual(selectTimelineRows(rows, 'main', null, false, 'parent', []).rows.map(r => r.id), ['main', 'new', 'old', 'unknown']);
  assert.deepEqual(selectTimelineRows(rows, 'main', 1, true, 'parent', []).rows.map(r => r.id), ['main', 'deleted']);
});

function pathXCoordinates(path) {
  const tokens = path.match(/[A-Z]|[-+]?(?:\d+\.?\d*|\.\d+)/g) ?? [];
  const arity = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, Z: 0 };
  const xIndexes = { M: [0], L: [0], H: [0], V: [], C: [0, 2, 4], S: [0, 2], Q: [0, 2], T: [0] };
  const xs = [];
  let command = null;
  let index = 0;
  while (index < tokens.length) {
    if (/^[A-Z]$/.test(tokens[index])) {
      command = tokens[index];
      index += 1;
      if (command === 'Z') continue;
    }
    assert.ok(command && arity[command] !== undefined, `unknown path command near ${tokens[index]}`);
    const count = arity[command];
    const values = tokens.slice(index, index + count).map(Number);
    assert.equal(values.length, count);
    for (const xIndex of xIndexes[command]) xs.push(values[xIndex]);
    index += count;
    if (command === 'M') command = 'L';
  }
  return xs;
}

function cubicCoordinates(path) {
  const values = path.match(/^M\s+([-+]?\d*\.?\d+)\s+([-+]?\d*\.?\d+)\s+C\s+([-+]?\d*\.?\d+)\s+([-+]?\d*\.?\d+),\s+([-+]?\d*\.?\d+)\s+([-+]?\d*\.?\d+),\s+([-+]?\d*\.?\d+)\s+([-+]?\d*\.?\d+)$/);
  assert.ok(values, `expected one cubic path: ${path}`);
  return values.slice(1).map(Number);
}

function cubicX([x1, , control1X, , control2X, , x2, ], t) {
  const oneMinusT = 1 - t;
  return oneMinusT ** 3 * x1
    + 3 * oneMinusT ** 2 * t * control1X
    + 3 * oneMinusT * t ** 2 * control2X
    + t ** 3 * x2;
}

test('every relation path and stub moves monotonically from past to present', () => {
  const routes = routeTimelineConnections([
    { id: 'down', x1: 80, x2: 220, y1: 44, y2: 220, rowDistance: 1 },
    { id: 'up', x1: 120, x2: 300, y1: 220, y2: 44, rowDistance: 4 },
    { id: 'same-time', x1: 220, x2: 220, y1: 44, y2: 220, rowDistance: 1 },
  ]);
  for (const route of routes) {
    if (route.path) {
      const coordinates = cubicCoordinates(route.path);
      assert.ok(coordinates[0] <= coordinates[2] && coordinates[2] <= coordinates[4] && coordinates[4] <= coordinates[6], `${route.id} cubic control points must be monotonic: ${route.path}`);
      let previous = -Infinity;
      for (const t of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
        const x = cubicX(coordinates, t);
        assert.ok(x + 1e-9 >= previous, `${route.id} sampled cubic x must not decrease at t=${t}`);
        previous = x;
      }
    }
    for (const path of [route.path, route.sourceStubPath, route.targetStubPath, route.arrow].filter(Boolean)) {
      const xs = pathXCoordinates(path);
      assert.ok(xs.every((value, index) => index === 0 || value >= xs[index - 1]), `${route.id} path x coordinates must not decrease: ${path}`);
    }
  }
  assert.equal(routes[0].path, 'M 80 44 C 150 44, 150 220, 220 220');
  assert.equal(routes[1].sourceStubPath, 'M 120 220 H 144');
  assert.equal(routes[1].targetStubPath, 'M 276 44 H 300');
});

test('reversed timestamps have endpoint markers only and explain why the line is absent', () => {
  const [route] = routeTimelineConnections([{ x1: 300, x2: 120, y1: 220, y2: 44, rowDistance: 5 }]);
  assert.equal(route.path, null);
  assert.equal(route.arrow, null);
  assert.equal(route.sourceStubPath, null);
  assert.equal(route.targetStubPath, null);
  assert.equal(route.reversed, true);
  assert.match(route.reason, /逆走/);
});

test('stub threshold starts at a four-row distance', () => {
  assert.equal(isTimelineConnectionStub(3), false);
  assert.equal(isTimelineConnectionStub(4), true);
  assert.equal(isTimelineConnectionStub(-4), true);
  const [route] = routeTimelineConnections([{ x1: 80, x2: 220, y1: 44, y2: 396, rowDistance: 4 }]);
  assert.equal(route.stub, true);
  assert.equal(route.sourceStubPath, 'M 80 44 H 104');
  assert.equal(route.targetStubPath, 'M 196 396 H 220');
});

test('stub routing rejects a missing row distance instead of drawing a full line', () => {
  assert.throws(() => routeTimelineConnections([{ x1: 80, x2: 220, y1: 44, y2: 396 }]), /rowDistance/);
});

test('non-default far relations stay hidden until an explicit context is present', () => {
  const route = { id: 'far', sourceRowId: 'main', targetRowId: 'topic', defaultVisible: false, drawn: true, stub: true };
  assert.equal(timelineConnectionDisplay(route, { showAll: false, focusedRouteId: null, activeRowIds: new Set() }), 'hidden');
  assert.equal(timelineConnectionDisplay({ ...route, defaultVisible: true }, { showAll: false, focusedRouteId: null, activeRowIds: new Set() }), 'stub');
  assert.equal(timelineConnectionDisplay(route, { showAll: false, focusedRouteId: null, activeRowIds: new Set(['topic']) }), 'full');
  assert.equal(timelineConnectionDisplay(route, { showAll: true, focusedRouteId: null, activeRowIds: new Set() }), 'full');
});

test('far relation chips aggregate stable default-visible relations by row and side', () => {
  const chips = aggregateTimelineConnectionChips([
    { routeId: 'merge-a', rowId: 'topic', rowIndex: 2, side: 'source', kind: 'merge', glyph: '↘', defaultVisible: true, stub: true, left: 100, width: 90 },
    { routeId: 'merge-b', rowId: 'topic', rowIndex: 2, side: 'source', kind: 'merge', glyph: '↘', defaultVisible: true, stub: true, left: 120, width: 90 },
    { routeId: 'merge-c', rowId: 'topic', rowIndex: 2, side: 'source', kind: 'merge', glyph: '↘', defaultVisible: true, stub: true, left: 110, width: 20 },
    { routeId: 'branch-a', rowId: 'topic', rowIndex: 2, side: 'target', kind: 'branch', glyph: '↙', defaultVisible: true, stub: true, left: 110, width: 20 },
  ]);
  assert.equal(chips.length, 2);
  const aggregate = chips.find((chip) => chip.type === 'aggregate');
  assert.ok(aggregate);
  assert.equal(aggregate.count, 3);
  assert.deepEqual(new Set(aggregate.routeIds), new Set(['merge-a', 'merge-b', 'merge-c']));
  assert.equal(chips.find((chip) => chip.routeIds.includes('branch-a')).type, 'single');
});

test('aggregate labels stay stable when contextual relation state changes', () => {
  const defaultVisible = [
    { routeId: 'merge-a', rowId: 'main', side: 'target', kind: 'merge', glyph: '↙', defaultVisible: true, stub: true },
    { routeId: 'merge-b', rowId: 'main', side: 'target', kind: 'merge', glyph: '↙', defaultVisible: true, stub: true },
  ];
  const contextual = [
    ...defaultVisible,
    { routeId: 'context-only', rowId: 'main', side: 'target', kind: 'merge', glyph: '↙', defaultVisible: false, stub: true, pinned: true },
    { routeId: 'other-side', rowId: 'main', side: 'source', kind: 'merge', glyph: '↘', defaultVisible: true, stub: true },
  ];
  const selected = defaultVisible.map((chip, index) => ({ ...chip, preserve: index === 0 }));
  assert.equal(aggregateTimelineConnectionChipLabel(defaultVisible, 'main', 'target'), '↙ 2件のマージ元');
  assert.equal(aggregateTimelineConnectionChipLabel(contextual, 'main', 'target'), '↙ 2件のマージ元');
  assert.equal(aggregateTimelineConnectionChipLabel(selected, 'main', 'target'), '↙ 2件のマージ元');
  assert.equal(aggregateTimelineConnectionChips(selected).find((chip) => chip.rowId === 'main' && chip.side === 'target').count, 2);
  assert.equal(aggregateTimelineConnectionChips(contextual).find((chip) => chip.rowId === 'main' && chip.side === 'target').label, '↙ 2件のマージ元');
});

test('default relation selection keeps one branch origin and one merge destination per row', () => {
  const edges = [
    { id: 'branch-inferred-only', kind: 'branch', source_row_id: 'main', target_row_id: 'topic', evidence: 'merge_base' },
    { id: 'branch-inferred-extra', kind: 'branch', source_row_id: 'release', target_row_id: 'topic', evidence: 'merge_base' },
    { id: 'branch-recorded-old', kind: 'branch', source_row_id: 'main', target_row_id: 'topic', evidence: 'reflog', occurred_at: '2026-01-01T00:00:00Z' },
    { id: 'branch-recorded-new', kind: 'branch', source_row_id: 'release', target_row_id: 'topic', evidence: 'pull_request', occurred_at: '2026-01-02T00:00:00Z' },
    { id: 'branch-sole-inferred', kind: 'branch', source_row_id: 'main', target_row_id: 'solo', evidence: 'merge_base' },
    { id: 'merge-recorded-old', kind: 'merge', source_row_id: 'topic', target_row_id: 'main', evidence: 'reflog', occurred_at: '2026-01-01T00:00:00Z' },
    { id: 'merge-recorded-new', kind: 'merge', source_row_id: 'topic', target_row_id: 'release', evidence: 'pull_request', occurred_at: '2026-01-03T00:00:00Z' },
    { id: 'merge-inferred', kind: 'merge', source_row_id: 'solo', target_row_id: 'main', evidence: 'merge_base' },
  ];
  const selected = selectDefaultTimelineConnectionEdges(edges);
  assert.deepEqual(selected.map((edge) => edge.id), [
    'branch-recorded-new',
    'branch-sole-inferred',
    'merge-recorded-new',
  ]);
  assert.ok(selected.filter((edge) => edge.kind === 'branch' && edge.target_row_id === 'topic').length <= 1);
  assert.ok(selected.filter((edge) => edge.kind === 'merge' && edge.source_row_id === 'topic').length <= 1);
});

test('parent order is depth-first, prefers recorded parents, and survives cycles', () => {
  const row = (id, date) => ({ id, name: id, historical: false, tip_commits: [{ date }] });
  const rows = [
    row('unknown', '2026-06-01'),
    row('old-child', '2025-01-01'),
    row('main', '2024-01-01'),
    row('new-child', '2026-01-01'),
    row('nested', '2024-06-01'),
    row('cycle-a', '2023-01-01'),
    row('cycle-b', '2023-02-01'),
  ];
  const edges = [
    { id: 'old-parent', kind: 'branch', source_row_id: 'main', target_row_id: 'old-child', evidence: 'merge_base', occurred_at: '2026-05-01T00:00:00Z' },
    { id: 'new-parent', kind: 'branch', source_row_id: 'main', target_row_id: 'new-child', evidence: 'reflog', occurred_at: '2026-01-01T00:00:00Z' },
    { id: 'nested-parent', kind: 'branch', source_row_id: 'new-child', target_row_id: 'nested', evidence: 'reflog', occurred_at: '2025-01-01T00:00:00Z' },
    { id: 'cycle-a-to-b', kind: 'branch', source_row_id: 'cycle-a', target_row_id: 'cycle-b', evidence: 'reflog' },
    { id: 'cycle-b-to-a', kind: 'branch', source_row_id: 'cycle-b', target_row_id: 'cycle-a', evidence: 'reflog' },
  ];
  assert.deepEqual(sortTimelineRows(rows, 'main', edges, 'parent').map((item) => item.id), [
    'main', 'new-child', 'nested', 'old-child', 'unknown', 'cycle-b', 'cycle-a',
  ]);
  assert.deepEqual(sortTimelineRows(rows, 'main', edges, 'updated').map((item) => item.id), [
    'main', 'unknown', 'new-child', 'old-child', 'nested', 'cycle-b', 'cycle-a',
  ]);
  assert.deepEqual(selectTimelineRows(rows, 'main', 2, false, 'parent', edges).rows.map((item) => item.id), [
    'main', 'new-child', 'unknown',
  ]);
});

test('parent selection ignores candidate parents outside the rendered row set', () => {
  const row = (id, date) => ({ id, name: id, historical: false, tip_commits: [{ date }] });
  const rows = [
    row('main', '2020-01-01'),
    row('visible-parent', '2026-01-01'),
    row('other-root', '2025-01-01'),
    row('child', '2024-01-01'),
  ];
  const edges = [
    { id: 'main-parent', kind: 'branch', source_row_id: 'main', target_row_id: 'visible-parent', evidence: 'reflog', occurred_at: '2026-01-01T00:00:00Z' },
    { id: 'visible-child', kind: 'branch', source_row_id: 'visible-parent', target_row_id: 'child', evidence: 'merge_base' },
    { id: 'hidden-child', kind: 'branch', source_row_id: 'hidden-parent', target_row_id: 'child', evidence: 'reflog', occurred_at: '2026-02-01T00:00:00Z' },
  ];
  assert.deepEqual(sortTimelineRows(rows, 'main', edges, 'parent').map((item) => item.id), [
    'main', 'visible-parent', 'child', 'other-root',
  ]);
});

test('most-recent parent ranking treats missing occurred_at as unknown', () => {
  const selected = selectDefaultTimelineConnectionEdges([
    { id: 'commit-date-only', kind: 'branch', source_row_id: 'main', target_row_id: 'topic', evidence: 'reflog', target_commit: { date: '2099-01-01' } },
    { id: 'occurred-known', kind: 'branch', source_row_id: 'release', target_row_id: 'topic', evidence: 'reflog', occurred_at: '2026-01-01T00:00:00Z' },
  ]);
  assert.deepEqual(selected.map((edge) => edge.id), ['occurred-known']);
});

test('connection selection counts hidden endpoints without dropping them from the relation index', () => {
  const result = selectTimelineConnectionEdges([
    { id: 'visible', source_row_id: 'main', target_row_id: 'topic' },
    { id: 'hidden', source_row_id: 'main', target_row_id: 'old' },
    { id: 'unresolved', source_row_id: null, target_row_id: 'main' },
  ], new Set(['main', 'topic']));
  assert.deepEqual(result.visible.map((edge) => edge.id), ['visible']);
  assert.deepEqual(result.hidden.map((edge) => edge.id), ['hidden', 'unresolved']);
  assert.equal(result.total, 3);
});

test('full-history event grouping stays responsive with one large lane', () => {
  const events = Array.from({ length: 34515 }, (_, index) => ({ lane: { id: 'main' }, id: String(index) }));
  const started = performance.now();
  const grouped = groupTimelineEventsByRow(events);
  const elapsed = performance.now() - started;
  assert.equal(grouped.size, 1);
  assert.equal(grouped.get('main').length, events.length);
  assert.equal(grouped.get('main')[0].id, '0');
  assert.equal(grouped.get('main').at(-1).id, String(events.length - 1));
  assert.ok(elapsed < 1500, `event grouping took ${elapsed.toFixed(1)}ms`);
});

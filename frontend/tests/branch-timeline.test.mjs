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

import { groupTimelineEventsByRow, selectTimelineRows, selectTimelineConnectionEdges, routeTimelineConnections } from '../app/timeline-layout.mjs';

test('recent branch limit keeps the default branch and sorts by tip date, with unknown dates last', () => {
  const row = (id, date, historical = false) => ({id, name: id, historical, tip_commits: [{date}]});
  const rows = [row('main', '2020-01-01'), row('old', '2024-01-01'), row('unknown', null), row('new', '2026-01-01'), row('deleted', '2027-01-01', true)];
  assert.deepEqual(selectTimelineRows(rows, 'main', 1, false).rows.map(r => r.id), ['main', 'new']);
  assert.deepEqual(selectTimelineRows(rows, 'main', null, false).rows.map(r => r.id), ['main', 'new', 'old', 'unknown']);
  assert.deepEqual(selectTimelineRows(rows, 'main', 1, true).rows.map(r => r.id), ['main', 'deleted']);
});

test('connection channels separate overlapping routes and avoid intervening commit dots', () => {
  const routes = routeTimelineConnections([
    { x1: 80, x2: 220, y1: 44, y2: 220 },
    { x1: 80, x2: 220, y1: 44, y2: 220 },
  ], [{x: 156, y: 132}], 440);
  assert.ok(Math.abs(routes[0].channel - 156) >= 12);
  assert.ok(Math.abs(routes[0].channel - routes[1].channel) >= 12);
  assert.ok(routes[0].path.startsWith('M 80 56 V 64'));
  assert.ok(routes[0].path.endsWith('H 220 V 208'));
  assert.match(routes[0].arrow, /L 220 208/);
});

test('upward connection points into the target dot without reversing source and target', () => {
  const [route] = routeTimelineConnections([{x1: 300, x2: 120, y1: 220, y2: 44}], [], 440);
  assert.ok(route.path.startsWith('M 300 208 V 200'));
  assert.ok(route.path.endsWith('H 120 V 56'));
  assert.equal(route.arrow, 'M 115 64 L 120 56 L 125 64 Z');
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

test('dense routes fan their horizontal legs without moving commit endpoints or dropping evidence', () => {
  const input = Array.from({ length: 12 }, (_, id) => ({ id, x1: 420, x2: 422, y1: 44, y2: 220 }));
  const routes = routeTimelineConnections(input, [], 440);
  assert.equal(routes.length, input.length);
  assert.equal(new Set(routes.slice(0, 3).map(route => route.fromY)).size, 3);
  assert.equal(new Set(routes.slice(0, 3).map(route => route.toY)).size, 3);
  assert.ok(routes.some(route => route.crowded));
  for (const [index, route] of routes.entries()) {
    assert.equal(route.id, input[index].id);
    assert.equal(route.x2, 422);
    assert.equal(route.y2, 220);
    assert.ok(route.fromY > 44 && route.fromY < 88);
    assert.ok(route.toY > 176 && route.toY < 220);
    assert.equal(route.arrowY, 208);
    assert.ok(route.arrow.endsWith(' Z'));
    assert.ok(!route.path.includes('NaN'));
  }
});

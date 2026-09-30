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

import { selectTimelineRows, routeTimelineConnections } from '../app/timeline-layout.mjs';

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
  assert.ok(routes[0].path.startsWith('M 80 44 V 64'));
  assert.ok(routes[0].path.endsWith('H 220 V 220'));
  assert.match(routes[0].arrow, /L 220 220/);
});

test('upward connection points into the target dot without reversing source and target', () => {
  const [route] = routeTimelineConnections([{x1: 300, x2: 120, y1: 220, y2: 44}], [], 440);
  assert.ok(route.path.startsWith('M 300 220 V 200'));
  assert.ok(route.path.endsWith('H 120 V 44'));
  assert.equal(route.arrow, 'M 116 51 L 120 44 L 124 51');
});

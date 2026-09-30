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

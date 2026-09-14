import assert from "node:assert/strict";
import test from "node:test";

import {
  ancestryRows,
  eventLeaderGeometry,
  flowEventKey,
  flowKeyboardAction,
  flowPopoverPlacement,
  layoutFlowEvents,
  mergeBasePosition,
  recentTimePosition,
  recentTimeAt,
  mergeRelationInWindow,
  mergeRelationLinks,
  routeMergeLinks,
  mergeRelationTimes,
  mobileEventAction,
  parseProjectUrl,
  shouldFoldMergedLane,
  updateProjectUrl,
} from "../app/project-flow.mjs";

function row(hash, parents = [], date = `2026-09-01T00:00:00+09:00`) {
  return { hash, parents, date };
}

test("ancestryRows returns only the real merge-base-to-head path in time order", () => {
  const rows = [
    row("head", ["middle"], "2026-09-03T00:00:00+09:00"),
    row("middle", ["base"], "2026-09-02T00:00:00+09:00"),
    row("base", ["old"], "2026-09-01T00:00:00+09:00"),
    row("old", [], "2026-08-01T00:00:00+09:00"),
  ];

  assert.deepEqual(
    ancestryRows(rows, "head", "base").map((item) => item.hash),
    ["base", "middle", "head"],
  );
});

test("merge path chooses the parent that reaches the explicit base", () => {
  const rows = [
    row("head", ["side", "main"], "2026-09-03T00:00:00+09:00"),
    row("side", ["side-base"], "2026-09-02T00:00:00+09:00"),
    row("main", ["base"], "2026-09-02T00:00:00+09:00"),
    row("side-base"),
    row("base"),
  ];

  assert.deepEqual(
    ancestryRows(rows, "head", "base").map((item) => item.hash),
    ["base", "main", "head"],
  );
});

test("URL state is restored and updated without dropping the project path", () => {
  const parsed = parseProjectUrl("?path=%2Fworkspace%2Frepo&tab=activity&range=7d&event=abc&lane=branch%3Afeature&at=35");
  assert.deepEqual(parsed, {
    path: "/workspace/repo",
    tab: "activity",
    range: "7d",
    merged: false,
    event: "abc",
    lane: "branch:feature",
    at: 35,
  });
  const next = updateProjectUrl(
    "http://localhost/project?path=%2Fworkspace%2Frepo&tab=flow&range=current",
    { tab: "activity", event: "abc", lane: "branch:feature" },
  );
  assert.equal(
    next,
    "/project?path=%2Fworkspace%2Frepo&tab=activity&range=current&event=abc&lane=branch%3Afeature",
  );
  assert.equal(parseProjectUrl(next.split("?")[1] ? `?${next.split("?")[1]}` : "").path, "/workspace/repo");
  assert.equal(parseProjectUrl("?merged=true").merged, true);
});

test("flow events are chronological, keyed by lane, and have distinct hit centers", () => {
  const events = [
    { id: flowEventKey("branch:feature", "late"), x: 50, row: row("late", [], "2026-09-03T00:00:00+09:00") },
    { id: flowEventKey("branch:feature", "early"), x: 50, row: row("early", [], "2026-09-02T00:00:00+09:00") },
  ];
  const positioned = layoutFlowEvents(events, 440);
  assert.deepEqual(positioned.map((item) => item.row.hash), ["early", "late"]);
  assert.ok(positioned[1].hitX - positioned[0].hitX >= 10);
  assert.notEqual(flowEventKey("branch:feature", "same"), flowEventKey("branch:other", "same"));
});

test("equal-time graph rows keep parent-to-child display order instead of hash order", () => {
  const sameTime = "2026-09-03T00:00:00+09:00";
  const positioned = layoutFlowEvents([
    { id: flowEventKey("branch:feature", "z-parent"), x: 50, row: row("z-parent", [], sameTime) },
    { id: flowEventKey("branch:feature", "a-child"), x: 50, row: row("a-child", ["z-parent"], sameTime) },
  ], 440);

  assert.deepEqual(positioned.map((item) => item.row.hash), ["z-parent", "a-child"]);
  assert.ok(positioned[1].hitX > positioned[0].hitX);
});

test("lane layout keeps the visible point centered on its 44px hit area", () => {
  const width = 440;
  const makeEvent = (lane, hash, x, date) => ({
    id: flowEventKey(lane, hash),
    x,
    lane,
    row: row(hash, [], date),
  });
  const laneA = layoutFlowEvents([
    makeEvent("branch:a", "a-old", 50, "2026-09-01T00:00:00+09:00"),
    makeEvent("branch:a", "a-new", 50, "2026-09-02T00:00:00+09:00"),
  ], width);
  const laneB = layoutFlowEvents([
    makeEvent("branch:b", "b-old", 50, "2026-09-01T00:00:00+09:00"),
    makeEvent("branch:b", "b-new", 50, "2026-09-02T00:00:00+09:00"),
  ], width);

  for (const laneEvents of [laneA, laneB]) {
    assert.ok((laneEvents[1].hitX - laneEvents[0].hitX) * width / 100 >= 44);
    for (const event of laneEvents) {
      const pointCenter = event.hitX * width / 100 + event.pointOffset;
      assert.ok(Math.abs(pointCenter - event.hitX * width / 100) < 0.001);
      assert.equal(event.pointOffset, 0);
      assert.equal(eventLeaderGeometry(event.timestampX, event.hitX, width).width, Math.abs((event.timestampX - event.hitX) * width / 100));
    }
  }
  // Equal timestamps in separate lanes may share an x coordinate; spacing is
  // an intra-lane hit-area constraint, not a global event-count displacement.
  assert.equal(laneA[0].hitX, laneB[0].hitX);
});

test("dense edge events move the interaction point inward and retain timestamp leader geometry", () => {
  const positioned = layoutFlowEvents([
    { id: flowEventKey("lane", "old"), x: 0, row: row("old", [], "2026-09-01T00:00:00+09:00") },
    { id: flowEventKey("lane", "new"), x: 100, row: row("new", [], "2026-09-02T00:00:00+09:00") },
  ], 440);
  assert.ok(positioned[0].hitX >= 5);
  assert.ok(positioned.at(-1).hitX <= 95);
  for (const event of positioned) {
    assert.equal(event.pointOffset, 0);
    const leader = eventLeaderGeometry(event.timestampX, event.hitX, 440);
    assert.equal(leader.offset, (event.timestampX - event.hitX) * 440 / 100);
    assert.equal(leader.width, Math.abs(leader.offset));
  }
});

test("body-level popover placement clamps horizontally and chooses a visible vertical side", () => {
  const placement = flowPopoverPlacement({
    anchorLeft: 320,
    anchorRight: 364,
    anchorTop: 540,
    anchorBottom: 584,
    viewportWidth: 360,
    viewportHeight: 640,
    preferredWidth: 290,
    preferredHeight: 220,
    margin: 8,
    gap: 12,
    preferBelow: true,
  });
  assert.equal(placement.width, 290);
  assert.equal(placement.height, 220);
  assert.equal(placement.side, "above");
  assert.ok(placement.left >= 8);
  assert.ok(placement.left + placement.width <= 352);
  assert.ok(placement.top >= 8);
  assert.ok(placement.top + placement.height <= 632);
  const below = flowPopoverPlacement({
    anchorLeft: 80,
    anchorRight: 124,
    anchorTop: 60,
    anchorBottom: 104,
    viewportWidth: 420,
    viewportHeight: 800,
    preferredWidth: 290,
    preferredHeight: 220,
    margin: 8,
    gap: 12,
    preferBelow: true,
  });
  assert.equal(below.side, "below");
  assert.equal(below.top, 116);

  const constrained = flowPopoverPlacement({
    anchorLeft: 120,
    anchorRight: 164,
    anchorTop: 140,
    anchorBottom: 184,
    viewportWidth: 667,
    viewportHeight: 375,
    preferredWidth: 290,
    preferredHeight: 500,
    margin: 8,
    gap: 12,
    preferBelow: false,
  });
  assert.equal(constrained.height, 359);
  assert.ok(constrained.top + constrained.height <= 367);
});

test("merge-base remains anchored at the range edge when its commit is hidden", () => {
  const start = Date.parse("2026-09-03T00:00:00+09:00");
  const end = Date.parse("2026-09-04T00:00:00+09:00");
  assert.deepEqual(
    mergeBasePosition("2026-09-09T00:00:00+09:00", start, end),
    { x: 100, outside: true, available: true },
  );
  assert.deepEqual(
    mergeBasePosition("2026-09-02T00:00:00+09:00", start, end),
    { x: 0, outside: true, available: true },
  );
  assert.deepEqual(
    mergeBasePosition("2026-09-03T12:00:00+09:00", start, end),
    { x: recentTimePosition(Date.parse("2026-09-03T12:00:00+09:00"), start, end), outside: false, available: true },
  );
});

test("merge links preserve source and non-default target direction", () => {
  const relation = {
    commit_hash: "merge",
    occurred_at: "2026-09-03T12:00:00+09:00",
    target_parent: "release-before-merge",
    source_parent: "feature-head",
    source_branch: "feature",
    source_lane_id: "branch:feature",
    target_branch: "release",
    target_lane_id: "branch:release",
  };
  const links = mergeRelationLinks(
    [relation],
    [{ id: "branch:main" }, { id: "branch:release" }, { id: "branch:feature" }],
    Date.parse("2026-09-03T00:00:00+09:00"),
    Date.parse("2026-09-04T00:00:00+09:00"),
    Date.parse("2026-09-04T00:00:00+09:00"),
    [{hash:"feature-head",date:"2026-09-03T06:00:00+09:00"}],
  );

  assert.equal(links.length, 1);
  assert.equal(links[0].sourceIndex, 2);
  assert.equal(links[0].targetIndex, 1);
  assert.equal(links[0].x, recentTimePosition(Date.parse("2026-09-03T12:00:00+09:00"),Date.parse("2026-09-03T00:00:00+09:00"),Date.parse("2026-09-04T00:00:00+09:00")));
  assert.equal(links[0].sourceX, recentTimePosition(Date.parse("2026-09-03T06:00:00+09:00"),Date.parse("2026-09-03T00:00:00+09:00"),Date.parse("2026-09-04T00:00:00+09:00")));
  assert.equal(links[0].target_branch, "release");
});

test("merge links omit unresolved, folded, and future relations", () => {
  const base = {
    commit_hash: "merge",
    occurred_at: "2026-09-03T12:00:00+09:00",
    target_parent: "release-before-merge",
    source_parent: "feature-head",
    source_branch: "feature",
    source_lane_id: "branch:feature",
    target_branch: "release",
    target_lane_id: "branch:release",
  };
  const args = [
    [{ id: "branch:release" }, { id: "branch:feature" }],
    Date.parse("2026-09-03T00:00:00+09:00"),
    Date.parse("2026-09-04T00:00:00+09:00"),
  ];
  assert.deepEqual(mergeRelationLinks([{ ...base, source_lane_id: null }], ...args, Date.parse("2026-09-04T00:00:00+09:00"), []), []);
  assert.deepEqual(mergeRelationLinks([base], [{ id: "branch:release" }], args[1], args[2], Date.parse("2026-09-04T00:00:00+09:00"), []), []);
  assert.deepEqual(mergeRelationLinks([base], ...args, Date.parse("2026-09-03T00:00:00+09:00"), []), []);
  assert.equal(mergeRelationInWindow(
    { ...base, occurred_at: "2026-09-01T00:00:00+09:00" },
    args[1],
    args[2],
    Date.parse("2026-09-04T00:00:00+09:00"),
  ), false);
});

test("merge relation times extend bounded and all-history flow windows", () => {
  const observedAt = Date.parse("2026-09-08T00:00:00+09:00");
  const relations = [
    { occurred_at: "2026-09-07T12:00:00+09:00" },
    { occurred_at: "2026-09-01T12:00:00+09:00" },
    { occurred_at: "invalid" },
    { occurred_at: "2026-09-09T00:00:00+09:00" },
  ];

  assert.deepEqual(mergeRelationTimes(relations, "current", observedAt), []);
  assert.deepEqual(mergeRelationTimes(relations, "24h", observedAt), [Date.parse(relations[0].occurred_at)]);
  assert.deepEqual(mergeRelationTimes(relations, "7d", observedAt), [
    Date.parse(relations[0].occurred_at),
    Date.parse(relations[1].occurred_at),
  ]);
  assert.deepEqual(mergeRelationTimes(relations, "all", observedAt), [
    Date.parse(relations[0].occurred_at),
    Date.parse(relations[1].occurred_at),
  ]);
});

test("arrow keys only move focus while Enter and Space select", () => {
  assert.equal(flowKeyboardAction("ArrowLeft"), "move");
  assert.equal(flowKeyboardAction("ArrowUp"), "move");
  assert.equal(flowKeyboardAction("Enter"), "select");
  assert.equal(flowKeyboardAction(" "), "select");
  assert.equal(flowKeyboardAction("Escape"), "none");
});

test("mobile touch activation keeps the first tap as preview and the second as selection", () => {
  assert.equal(mobileEventAction({ isMobile: true, isTouch: true, previewAtPointerDown: false }), "preview");
  assert.equal(mobileEventAction({ isMobile: true, isTouch: true, previewAtPointerDown: true }), "select");
  assert.equal(mobileEventAction({ isMobile: false, isTouch: true, previewAtPointerDown: false }), "select");
});

test("merged folding keeps active lanes visible but folds prunable worktrees", () => {
  assert.equal(shouldFoldMergedLane({ merged: true, is_worktree: true, dirty: false, conflict: false }), false);
  assert.equal(shouldFoldMergedLane({ merged: true, is_worktree: false, dirty: false, conflict: false }), true);
  assert.equal(shouldFoldMergedLane({ merged: null, is_worktree: false, dirty: false, conflict: false }), false);
  assert.equal(shouldFoldMergedLane({ merged: null, worktree_state: "prunable", is_worktree: false, dirty: false, conflict: false }), true);
  assert.equal(shouldFoldMergedLane({ merged: null, worktree_state: "prunable", is_worktree: true, dirty: false, conflict: false }), true);
  assert.equal(shouldFoldMergedLane({ merged: null, worktree_state: "prunable", is_worktree: true, dirty: true, conflict: false }), false);
  assert.equal(shouldFoldMergedLane({ merged: null, worktree_state: "locked", is_worktree: false, dirty: false, conflict: false }), false);
});


test("dense merges keep distinct routes and observed endpoints", () => {
  const links = Array.from({ length: 30 }, (_, index) => ({
    sourceX: 0, x: 100, sourceIndex: index + 1, targetIndex: 0,
    commit_hash: `merge-${index}`, source_parent: `parent-${index}`,
  }));
  const width = links.length * 16 + 48;
  const routes = routeMergeLinks(links, width, 88);
  assert.equal(routes.length, links.length);
  assert.equal(new Set(routes.map((route) => route.channel)).size, links.length);
  for (const route of routes) {
    assert.ok(route.channel >= route.startX && route.channel <= route.endX);
    assert.ok(route.path.startsWith(`M ${route.sourceX * width / 100} ${(route.sourceIndex + .5) * 88}`));
    assert.ok(route.path.endsWith(`H ${route.x * width / 100}`));
    assert.ok(!route.path.includes("NaN"));
  }
  assert.deepEqual(routeMergeLinks([...links].reverse(), width, 88), routes);
});

test("routing retains both merge directions and reuses disjoint columns", () => {
  const links = [
    { sourceX: 20, x: 50, sourceIndex: 0, targetIndex: 1, commit_hash: "a", source_parent: "a" },
    { sourceX: 20, x: 50, sourceIndex: 3, targetIndex: 2, commit_hash: "b", source_parent: "b" },
  ];
  const [down, up] = routeMergeLinks(links, 440, 88);
  assert.equal(down.channel, up.channel);
  assert.equal(down.arrow, `M ${down.channel - 4} 84 L ${down.channel} 91 L ${down.channel + 4} 84`);
  assert.equal(up.arrow, `M ${up.channel - 4} 268 L ${up.channel} 261 L ${up.channel + 4} 268`);
  assert.throws(() => routeMergeLinks(links, 0, 88), RangeError);
});


test("short and equal-time routes never turn back along the time axis", () => {
  for (const end of [50, 50.001, 51]) {
    const links = Array.from({length: 20}, (_, i) => ({sourceX:50, x:end,sourceIndex:i+1,targetIndex:0,commit_hash:String(i),source_parent:String(i)}));
    const routes = routeMergeLinks(links, 440, 88);
    assert.equal(routes.length, 20);
    for (const route of routes) {
      const coordinates = [...route.path.matchAll(/[MHVQ] ([^MHVQ]+)/g)].flatMap(([_, part], index) => {
        const values = part.trim().split(/\s+/).map(Number);
        return values.length === 1 ? (route.path.match(/[MHVQ]/g)[index] === "H" ? values : []) : values.filter((_, i) => i % 2 === 0);
      });
      assert.ok(coordinates.every((x,i) => i === 0 || x >= coordinates[i-1]), route.path);
      assert.equal(coordinates[0], 220);
      assert.equal(coordinates.at(-1), end * 440 / 100);
    }
  }
});

test("missing or inverted source dates are explicit and never fabricated", () => {
  const relation = {source_lane_id:"s",target_lane_id:"t",source_parent:"parent",commit_hash:"merge",occurred_at:"2026-09-03T12:00:00Z"};
  const args = [[relation],[{id:"s"},{id:"t"}],Date.parse("2026-09-03T00:00:00Z"),Date.parse("2026-09-04T00:00:00Z"),Date.parse("2026-09-04T00:00:00Z")];
  for (const rows of [[],[{hash:"parent",date:"2026-09-03T13:00:00Z"}]]) {
    const links = mergeRelationLinks(...args, rows);
    assert.equal(links[0].sourceX, null);
    assert.deepEqual(routeMergeLinks(links,440,88),[]);
  }
  const [clipped] = mergeRelationLinks(...args,[{hash:"parent",date:"2026-09-02T00:00:00Z"}]);
  assert.equal(clipped.sourceX,0);
  assert.equal(clipped.sourceOutside,true);
});


test("recent time scale expands recent hours and remains monotonic and invertible", () => {
  const now = Date.parse("2026-09-14T12:00:00Z"), hour = 3_600_000;
  for (const duration of [hour, 24*hour, 7*24*hour, 365*24*hour]) {
    const min = now-duration;
    assert.equal(recentTimePosition(min,min,now),0);
    assert.equal(recentTimePosition(now,min,now),100);
    let previous = -1;
    for(let i=0;i<=100;i++) {
      const time = min+duration*i/100;
      const position = recentTimePosition(time,min,now);
      assert.ok(position > previous);
      assert.ok(Math.abs(recentTimeAt(position,min,now)-time)<.01);
      previous = position;
    }
    assert.ok(100-recentTimePosition(now-hour/2,min,now) > recentTimePosition(min+hour/2,min,now));
    assert.ok(recentTimeAt(50,min,now) > min+duration/2);
    assert.equal(mergeBasePosition(new Date(now-hour/2).toISOString(),min,now).x,recentTimePosition(now-hour/2,min,now));
  }
});

test("logarithmic slider preserves the URL's elapsed-time percentage", () => {
  const min=Date.parse("2026-09-01T00:00:00Z"), max=Date.parse("2026-09-14T00:00:00Z");
  const observed=min+(max-min)*.7;
  const slider=recentTimePosition(observed,min,max);
  assert.ok(Math.abs((recentTimeAt(slider,min,max)-min)/(max-min)*100-70)<1e-9);
  assert.equal(recentTimeAt(100,min,max),max);
  assert.equal(recentTimePosition(min-1000,min,max),0);
  assert.equal(recentTimePosition(max+1000,min,max),100);
  assert.throws(()=>recentTimePosition(max,min,min),RangeError);
});

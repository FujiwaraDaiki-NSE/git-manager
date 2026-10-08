import assert from "node:assert/strict";
import test from "node:test";
import {
  basename,
  buildWorktreeInventory,
  escapeTsvCell,
  filterWorktreeInventory,
  worktreeBranchFilterValue,
  worktreeBranchKey,
  worktreeCdCommands,
  shellQuote,
  sortWorktreeInventory,
  summarizeWorktreeInventory,
  worktreeCdCommand,
  worktreeHealth,
  worktreeHealthTokens,
  worktreeInventoryTsv,
  worktreeState,
  worktreeStateTokens,
  worktreeSync,
} from "../app/worktree-tools.mjs";

function worktree(overrides = {}) {
  return {
    path: "/repo/main",
    branch: "main",
    head: "1111111111111111111111111111111111111111",
    state: "ok",
    detached: false,
    is_main: true,
    ...overrides,
  };
}

function lane(path, overrides = {}) {
  return {
    id: path,
    name: path,
    path,
    branch: "main",
    dirty: false,
    conflict: false,
    upstream: "origin/main",
    upstream_ahead: 0,
    upstream_behind: 0,
    ...overrides,
  };
}

function filterOptions(overrides = {}) {
  return {
    query: "",
    state: "all",
    health: "all",
    sync: "all",
    branch: "all",
    ...overrides,
  };
}

test("inventory membership is authoritative and lane links require an exact path", () => {
  const exact = lane("/repo/main");
  const project = {
    worktrees: [
      worktree(),
      worktree({ path: "/repo/missing", branch: "feature/missing", is_main: false }),
    ],
    lanes: [exact, lane("/repo/main/child", { name: "wrong prefix" })],
  };
  const rows = buildWorktreeInventory(project);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].lane, exact);
  assert.equal(rows[1].lane, null);
  assert.equal(buildWorktreeInventory({
    worktrees: [worktree()],
    lanes: [exact, lane("/repo/main", { name: "duplicate" })],
  })[0].lane, null);
  assert.equal(basename("/repo/main/"), "main");
  assert.equal(basename("C:\\repo\\feature"), "feature");
});

test("null worktree and lane facts remain unknown instead of becoming clean", () => {
  const row = {
    worktree: worktree({ state: null, detached: false, is_main: false, branch: null }),
    lane: lane("/repo/unknown", { dirty: null, conflict: null }),
  };
  assert.equal(worktreeState(row.worktree), "unknown");
  assert.equal(worktreeHealth(row), "unknown");
  assert.equal(filterWorktreeInventory([row], filterOptions({ state: "unknown", health: "unknown" })).length, 1);
  assert.equal(filterWorktreeInventory([row], filterOptions({ state: "ok", health: "clean" })).length, 0);
  const mainWithMissingState = { worktree: worktree({ state: null }), lane: lane("/repo/main", { dirty: false, conflict: false }) };
  assert.deepEqual(worktreeStateTokens(mainWithMissingState.worktree), ["main", "unknown"]);
  assert.equal(filterWorktreeInventory([mainWithMissingState], filterOptions({ state: "unknown" })).length, 1);
});

test("state and health filters select only explicit facts", () => {
  const rows = [
    { worktree: worktree(), lane: lane("/repo/main") },
    { worktree: worktree({ path: "/repo/feature", branch: "feature/x", is_main: false, state: "ok" }), lane: lane("/repo/feature", { dirty: true }) },
    { worktree: worktree({ path: "/repo/detached", branch: null, is_main: false, state: "ok", detached: true }), lane: lane("/repo/detached", { conflict: true, dirty: true }) },
    { worktree: worktree({ path: "/repo/stale", branch: null, is_main: false, state: "prunable" }), lane: null },
  ];
  assert.deepEqual(filterWorktreeInventory(rows, filterOptions({ state: "detached" })).map((row) => row.worktree.path), ["/repo/detached"]);
  assert.deepEqual(filterWorktreeInventory(rows, filterOptions({ health: "dirty" })).map((row) => row.worktree.path), ["/repo/feature", "/repo/detached"]);
  assert.deepEqual(filterWorktreeInventory(rows, filterOptions({ health: "conflict" })).map((row) => row.worktree.path), ["/repo/detached"]);
  assert.deepEqual(filterWorktreeInventory(rows, filterOptions({ state: "prunable", health: "unknown" })).map((row) => row.worktree.path), ["/repo/stale"]);
  const partialUnknown = { worktree: worktree({ path: "/repo/partial", branch: "feature/partial", is_main: false }), lane: lane("/repo/partial", { dirty: true, conflict: null }) };
  assert.deepEqual(worktreeHealthTokens(partialUnknown), ["dirty", "unknown"]);
  assert.deepEqual(filterWorktreeInventory([partialUnknown], filterOptions({ health: "unknown" })).map((row) => row.worktree.path), ["/repo/partial"]);
  assert.deepEqual(summarizeWorktreeInventory(rows), {
    total: 4,
    main: 1,
    ok: 3,
    detached: 1,
    prunable: 1,
    locked: 0,
    unknown: 0,
    dirty: 2,
    conflict: 1,
    healthUnknown: 1,
  });
});

test("upstream synchronization uses only explicit lane tracking facts", () => {
  const rows = [
    { worktree: worktree({ path: "/repo/synced", branch: "main" }), lane: lane("/repo/synced", { upstream: "origin/main", upstream_ahead: 0, upstream_behind: 0 }) },
    { worktree: worktree({ path: "/repo/ahead", branch: "feature/ahead", is_main: false }), lane: lane("/repo/ahead", { upstream: "origin/ahead", upstream_ahead: 2, upstream_behind: 0 }) },
    { worktree: worktree({ path: "/repo/behind", branch: "feature/behind", is_main: false }), lane: lane("/repo/behind", { upstream: "origin/behind", upstream_ahead: 0, upstream_behind: 3 }) },
    { worktree: worktree({ path: "/repo/diverged", branch: "feature/diverged", is_main: false }), lane: lane("/repo/diverged", { upstream: "origin/diverged", upstream_ahead: 2, upstream_behind: 3 }) },
    { worktree: worktree({ path: "/repo/no-upstream", branch: "feature/local", is_main: false }), lane: lane("/repo/no-upstream", { upstream: null, upstream_ahead: 7, upstream_behind: 4 }) },
    { worktree: worktree({ path: "/repo/missing-counts", branch: "feature/missing", is_main: false }), lane: lane("/repo/missing-counts", { upstream: "origin/missing", upstream_ahead: null, upstream_behind: null }) },
    { worktree: worktree({ path: "/repo/missing-upstream", branch: "feature/unknown", is_main: false }), lane: lane("/repo/missing-upstream", { upstream: undefined, upstream_ahead: 0, upstream_behind: 0 }) },
    { worktree: worktree({ path: "/repo/no-lane", branch: "feature/no-lane", is_main: false }), lane: null },
  ];
  assert.deepEqual(rows.map((row) => worktreeSync(row)), [
    "synced", "ahead", "behind", "diverged", "no-upstream", "unknown", "unknown", "unknown",
  ]);
  for (const filter of ["ahead", "behind", "diverged", "synced", "no-upstream", "unknown"]) {
    assert.deepEqual(
      filterWorktreeInventory(rows, filterOptions({ sync: filter })).map((row) => row.worktree.path),
      rows.filter((row) => worktreeSync(row) === filter).map((row) => row.worktree.path),
    );
  }
  const combined = filterWorktreeInventory(rows, filterOptions({
    query: "feature",
    state: "ok",
    health: "clean",
    sync: "ahead",
    branch: worktreeBranchFilterValue("feature/ahead"),
  }));
  assert.deepEqual(combined.map((row) => row.worktree.path), ["/repo/ahead"]);
});

test("branch selector preserves exact branches and distinguishes detached from unknown", () => {
  const exact = { worktree: worktree({ path: "/repo/exact", branch: "detached", detached: false }), lane: null };
  const detached = { worktree: worktree({ path: "/repo/detached", branch: null, detached: true }), lane: null };
  const unknown = { worktree: worktree({ path: "/repo/unknown", branch: null, detached: false }), lane: null };
  assert.equal(worktreeBranchKey(exact), "branch:detached");
  assert.equal(worktreeBranchKey(detached), "detached");
  assert.equal(worktreeBranchKey(unknown), "unknown");
  assert.deepEqual(filterWorktreeInventory([exact, detached, unknown], filterOptions({ branch: "branch:detached" })).map((row) => row.worktree.path), ["/repo/exact"]);
  assert.deepEqual(filterWorktreeInventory([exact, detached, unknown], filterOptions({ branch: "detached" })).map((row) => row.worktree.path), ["/repo/detached"]);
  assert.deepEqual(filterWorktreeInventory([exact, detached, unknown], filterOptions({ branch: "unknown" })).map((row) => row.worktree.path), ["/repo/unknown"]);
});

test("sorting supports branch, path, and status without mutating the source", () => {
  const rows = [
    { worktree: worktree({ path: "/repo/z", branch: "z", is_main: false }), lane: lane("/repo/z", { dirty: false }) },
    { worktree: worktree({ path: "/repo/a", branch: "a", is_main: false, state: "locked" }), lane: null },
    { worktree: worktree({ path: "/repo/c", branch: "c", is_main: false, detached: true }), lane: lane("/repo/c", { dirty: false }) },
    { worktree: worktree({ path: "/repo/d", branch: null, is_main: false, state: null }), lane: null },
  ];
  assert.deepEqual(sortWorktreeInventory(rows, "branch").map((row) => row.worktree.path), ["/repo/a", "/repo/c", "/repo/z", "/repo/d"]);
  assert.deepEqual(sortWorktreeInventory(rows, "path").map((row) => row.worktree.path), ["/repo/a", "/repo/c", "/repo/d", "/repo/z"]);
  assert.deepEqual(sortWorktreeInventory(rows, "status").map((row) => row.worktree.path), ["/repo/a", "/repo/c", "/repo/z", "/repo/d"]);
  assert.deepEqual(rows.map((row) => row.worktree.path), ["/repo/z", "/repo/a", "/repo/c", "/repo/d"]);
});

test("shell commands quote apostrophes and refuse a missing path", () => {
  assert.equal(shellQuote("/tmp/it's repo"), "'/tmp/it'\\''s repo'");
  assert.equal(worktreeCdCommand("/tmp/it's repo"), "cd -- '/tmp/it'\\''s repo'");
  assert.equal(worktreeCdCommands([
    { worktree: { path: "/tmp/it's repo" } },
    { worktree: { path: "/tmp/second" } },
    { worktree: { path: "" } },
  ]), "cd -- '/tmp/it'\\''s repo'\ncd -- '/tmp/second'");
  assert.equal(worktreeCdCommand(null), null);
  assert.equal(worktreeCdCommand(""), null);
});

test("TSV cells neutralize formula prefixes and delimiters while preserving unknowns", () => {
  assert.equal(escapeTsvCell("=HYPERLINK(\"x\")"), "'=HYPERLINK(\"x\")");
  assert.equal(escapeTsvCell("+1\tsecond\nthird"), "'+1 second third");
  assert.equal(escapeTsvCell(null), "");
  const rows = [{
    worktree: worktree({ path: "/repo/feature\t=bad", branch: "=formula", state: null, is_main: false }),
    lane: lane("/repo/feature\t=bad", { dirty: null, conflict: null }),
  }];
  const tsv = worktreeInventoryTsv(rows);
  assert.match(tsv, /^path\tbranch\thead\tstate\tis_main\tdetached\tdirty\tconflict\tlane_id\tupstream\tupstream_ahead\tupstream_behind\tupstream_sync\n/);
  assert.match(tsv, /\t'=formula\t/);
  assert.match(tsv, /\/repo\/feature =bad\t/);
  assert.match(tsv, /\t\tfalse\tfalse\t\t\t/);
  assert.equal(tsv.includes("\tmain\t"), false);
  const mainTsv = worktreeInventoryTsv([{ worktree: worktree({ state: "ok", is_main: true }), lane: lane("/repo/main") }]);
  assert.match(mainTsv, /\/repo\/main\tmain\t1111111111111111111111111111111111111111\tok\ttrue\tfalse/);
  assert.equal(tsv.includes("\nthird"), false);
});

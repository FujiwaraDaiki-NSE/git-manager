import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeLaneAuthor,
  escapeLaneCsvCell,
  hasUnknownLaneAuthor,
  laneAgentStatus,
  laneAgentStatusValue,
  laneAuthors,
  laneCsv,
  laneMatchesAuthor,
  laneMatchesUpstream,
  laneSummaryMarkdown,
  laneUpstreamState,
  LANE_CSV_HEADERS,
  UNKNOWN_LANE_AUTHOR_FILTER,
} from "../app/lane-explorer-tools.mjs";

function lane(overrides = {}) {
  return {
    id: "branch:main",
    name: "main",
    branch: "main",
    path: "/repo/main",
    head: "abc123",
    default_ahead: 0,
    default_behind: 0,
    upstream: "origin/main",
    upstream_ahead: 0,
    upstream_behind: 0,
    last_commit: { hash: "abc123", subject: "Initial", author: "Alice", date: "2026-10-14T00:00:00Z" },
    agent: { kind: "status", status: "testing", branch: "main" },
    ...overrides,
  };
}

test("author choices preserve exact values and expose missing commit authors", () => {
  const alice = lane();
  const quoted = lane({ id: "branch:quoted", last_commit: { ...alice.last_commit, author: "A+B, exact" } });
  const unknown = lane({ id: "branch:unknown", last_commit: null });
  assert.deepEqual(laneAuthors([quoted, alice, lane({ id: "branch:duplicate" })]), ["A+B, exact", "Alice"]);
  assert.equal(hasUnknownLaneAuthor([alice, quoted]), false);
  assert.equal(hasUnknownLaneAuthor([alice, unknown]), true);
  assert.equal(laneMatchesAuthor(quoted, encodeLaneAuthor("A+B, exact")), true);
  assert.equal(laneMatchesAuthor(quoted, encodeLaneAuthor("Alice")), false);
  assert.equal(laneMatchesAuthor(unknown, UNKNOWN_LANE_AUTHOR_FILTER), true);
  assert.equal(laneMatchesAuthor(alice, UNKNOWN_LANE_AUTHOR_FILTER), false);
  assert.equal(laneMatchesAuthor(alice, ""), true);
});

test("upstream filter uses tracking identity and complete nonnegative counts", () => {
  const states = [
    lane({ upstream: "origin/main", upstream_ahead: 0, upstream_behind: 0 }),
    lane({ upstream: "origin/main", upstream_ahead: 2, upstream_behind: 0 }),
    lane({ upstream: "origin/main", upstream_ahead: 0, upstream_behind: 3 }),
    lane({ upstream: "origin/main", upstream_ahead: 2, upstream_behind: 3 }),
    lane({ upstream: null, upstream_ahead: null, upstream_behind: null }),
    lane({ upstream: undefined, upstream_ahead: 0, upstream_behind: 0 }),
    lane({ upstream: "origin/main", upstream_ahead: null, upstream_behind: 0 }),
    lane({ upstream: "origin/main", upstream_ahead: -1, upstream_behind: 0 }),
  ];
  assert.deepEqual(states.map(laneUpstreamState), ["synced", "ahead", "behind", "diverged", "untracked", "unknown", "unknown", "unknown"]);
  assert.deepEqual(states.filter((item) => laneMatchesUpstream(item, "unknown")).length, 3);
  assert.equal(laneMatchesUpstream(states[4], "untracked"), true);
  assert.equal(laneMatchesUpstream(states[0], "all"), true);
  assert.equal(laneMatchesUpstream(states[1], "behind"), false);
});

test("agent status export stays unknown for lifecycle or malformed reports", () => {
  const lifecycle = lane({ agent: { kind: "lifecycle", status: "testing", run_state: "active", phase: "testing" } });
  const malformed = lane({ agent: { kind: "status", status: "not-a-contract-status", run_state: "active" } });
  assert.equal(laneAgentStatus(lifecycle), null);
  assert.equal(laneAgentStatusValue(lifecycle), "unknown");
  assert.equal(laneAgentStatus(malformed), null);
  assert.equal(laneAgentStatusValue(malformed), "unknown");
  assert.equal(laneAgentStatusValue(lane()), "testing");
});

test("CSV includes divergence and upstream facts and neutralizes spreadsheet formulas", () => {
  const dangerous = lane({
    branch: "=HYPERLINK(\"x\")",
    path: "/repo/a,b\nnext",
    head: "+head",
    default_ahead: null,
    default_behind: null,
    upstream: "origin/feature",
    upstream_ahead: 4,
    upstream_behind: 1,
    last_commit: { hash: "h", subject: "=SUM(A1)", author: "@author", date: null },
    agent: null,
  });
  const csv = laneCsv([dangerous]);
  assert.equal(csv.startsWith("\uFEFF"), true);
  assert.equal(csv.includes(LANE_CSV_HEADERS.map((header) => `"${header}"`).join(",")), true);
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
  assert.match(csv, /"'\+head"/);
  assert.match(csv, /"\/repo\/a,b\nnext"/);
  assert.match(csv, /"origin\/feature","4","1","diverged"/);
  assert.match(csv, /"'=SUM\(A1\)"/);
  assert.match(csv, /"unknown"$/);
  assert.equal(escapeLaneCsvCell("@danger"), '"\'@danger"');
});

test("Markdown handoff has complete table rows, upstream target, and escaped content", () => {
  const source = lane({
    branch: "feature|one",
    path: "/repo/<unsafe>",
    upstream: "origin/feature",
    upstream_ahead: 1,
    upstream_behind: 0,
    last_commit: { hash: "hash", subject: "title | <tag>", author: "Alice", date: "2026-10-14" },
    agent: { kind: "lifecycle", status: "testing", run_state: "active" },
  });
  const markdown = laneSummaryMarkdown({ name: "demo & <repo>", main_path: "/repo/demo", default_branch: "main" }, [source]);
  assert.match(markdown, /^\| feature\\\|one \|/m);
  assert.match(markdown, /\| origin\/feature \| 1 \| 0 \| ahead \|/);
  assert.match(markdown, /title \\\| &lt;tag&gt;/);
  assert.match(markdown, /agent status \|\n\|/);
  assert.equal(markdown.includes("<unsafe>"), false);
  assert.equal(markdown.includes("<repo>"), false);
  assert.match(markdown, /unknown \|\n$/);
});

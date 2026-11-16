import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateAgentCounts,
  agentCount,
  countProjectsWithUnknownAgentCounts,
  hasUnknownAgentCounts,
  homeHref,
  homeSearch,
  matchesAgentFilter,
  matchesGitFilter,
  parseFavoriteIds,
  parseHomeUrl,
  projectMatchesView,
  sortHomeProjects,
} from "../app/home-overview.mjs";

const counts = (overrides = {}) => ({
  waiting_for_user: 0,
  blocked: 0,
  active: 0,
  review_required: 0,
  merge_ready: 0,
  completed: 0,
  ...overrides,
});

const project = (id, overrides = {}) => ({
  id,
  name: id,
  remote: null,
  git_status_failed: 0,
  main_path: `/repo/${id}`,
  git: { dirty: 0, conflict: 0, ahead: 0, behind: 0 },
  agent_priority_counts: counts(),
  agent_tasks: [],
  latest_event: null,
  latest_agent_event: null,
  latest_observed_at: 0,
  agent_state: null,
  ...overrides,
});

test("agent summary totals sum published counts without converting unknown counts to zero", () => {
  const known = project("known", { agent_priority_counts: counts({ active: 2 }) });
  const unknown = project("unknown", { agent_priority_counts: { ...counts(), active: null } });
  assert.equal(agentCount(known, "active"), 2);
  assert.equal(agentCount(unknown, "active"), null);
  assert.deepEqual(aggregateAgentCounts([known, unknown]), {
    waiting_for_user: 0,
    blocked: 0,
    active: 2,
    review_required: 0,
    merge_ready: 0,
  });
  assert.equal(hasUnknownAgentCounts(unknown), true);
  assert.equal(countProjectsWithUnknownAgentCounts([known, unknown]), 1);
});

test("agent and Git filters use the published counts", () => {
  const waiting = project("waiting", {
    agent_priority_counts: counts({ waiting_for_user: 1 }),
    git: { dirty: 1, conflict: 0, ahead: 0, behind: 0 },
  });
  const clean = project("clean");
  const unknown = project("unknown", { agent_priority_counts: { ...counts(), blocked: null } });
  assert.equal(matchesAgentFilter(waiting, "waiting_for_user"), true);
  assert.equal(matchesAgentFilter(clean, "waiting_for_user"), false);
  assert.equal(matchesAgentFilter(unknown, "unknown"), true);
  assert.equal(matchesGitFilter(waiting, "dirty"), true);
  assert.equal(matchesGitFilter(waiting, "conflict"), false);
  assert.equal(matchesGitFilter(clean, "behind"), false);
});

test("search, favorites, agent, and Git filters compose without losing the query", () => {
  const selected = project("selected", {
    name: "Selected App",
    remote: "github.com/acme/selected",
    agent_priority_counts: counts({ active: 1 }),
    git: { dirty: 1, conflict: 0, ahead: 0, behind: 0 },
  });
  const view = {
    query: "selected",
    agentFilter: "active",
    gitFilter: "dirty",
    sort: "name",
    favoritesOnly: true,
    hideDormant: false,
    density: "compact",
  };
  assert.equal(projectMatchesView(selected, view, new Set(["selected"])), true);
  assert.equal(projectMatchesView(selected, view, new Set()), false);
  assert.equal(homeSearch(view), "q=selected&agent=active&git=dirty&sort=name&favorites=1&density=compact");
  assert.equal(homeHref(view, "/"), "/?q=selected&agent=active&git=dirty&sort=name&favorites=1&density=compact");
});

test("URL state validates filters and round-trips shareable view options", () => {
  const parsed = parseHomeUrl("?q=feature%20one&agent=unknown&git=behind&sort=latest&favorites=1&density=compact");
  const view = parsed.view;
  assert.deepEqual(view, {
    query: "feature one",
    agentFilter: "unknown",
    gitFilter: "behind",
    sort: "latest",
    favoritesOnly: true,
    hideDormant: false,
    density: "compact",
  });
  assert.deepEqual(parsed.invalidParams, []);
  const invalid = parseHomeUrl("?agent=made-up&git=made-up&sort=made-up&density=made-up");
  assert.equal(invalid.view, null);
  assert.deepEqual(invalid.invalidParams, ["agent=made-up", "git=made-up", "sort=made-up", "density=made-up"]);
  assert.deepEqual(parseHomeUrl(`?${homeSearch(view)}`).view, view);
});

test("home sorting supports priority, name, and latest", () => {
  const projects = [
    project("zeta", { name: "Zeta", agent_state: "active", latest_event: { date: "2026-09-01T00:00:00Z" } }),
    project("alpha", { name: "Alpha", agent_state: "waiting_for_user", latest_event: { date: "2026-09-01T01:00:00Z" } }),
  ];
  assert.deepEqual(sortHomeProjects(projects, "priority").map((item) => item.id), ["alpha", "zeta"]);
  assert.deepEqual(sortHomeProjects(projects, "name").map((item) => item.id), ["alpha", "zeta"]);
  assert.deepEqual(sortHomeProjects(projects, "latest").map((item) => item.id), ["alpha", "zeta"]);
});

test("favorites storage accepts only string ids and removes duplicates", () => {
  assert.deepEqual(parseFavoriteIds('["a","a","b"]'), ["a", "b"]);
  assert.equal(parseFavoriteIds('{"id":"a"}'), null);
  assert.equal(parseFavoriteIds("invalid"), null);
  assert.deepEqual(parseFavoriteIds(null), []);
});

test("returning to the list restores only local filter parameters", async () => {
  const { homeReturnHref } = await import("../app/home-overview.mjs");
  assert.equal(homeReturnHref(null), "/");
  assert.equal(homeReturnHref("q=git&sort=name&density=compact"), "/?q=git&sort=name&density=compact");
  assert.equal(homeReturnHref("https://external.example/path"), "/");
  assert.equal(homeReturnHref("git=invalid"), "/?git=invalid");
});

test("entirely unknown totals stay unknown while published zero and empty totals are zero", () => {
  const unknown = project("unknown", { agent_priority_counts: null });
  assert.equal(aggregateAgentCounts([unknown]).active, null);
  assert.equal(aggregateAgentCounts([unknown, project("zero")]).active, 0);
  assert.equal(aggregateAgentCounts([]).active, 0);
  assert.equal(matchesAgentFilter(unknown, "active"), false);
});

test("dormancy requires an old commit and known quiet Git and agent facts", async () => {
  const { isDormantProject } = await import("../app/home-overview.mjs");
  const now = Date.parse("2026-11-16T00:00:00Z");
  const old = project("old", { latest_event: { date: "2026-10-17T00:00:00Z" } });
  assert.equal(isDormantProject(old, {}, now), true);
  assert.equal(isDormantProject(old, {}, now - 1), false);
  for (const latest_event of [null, { date: null }, { date: "invalid" }])
    assert.equal(isDormantProject({ ...old, latest_event }, {}, now), false);
  for (const key of ["dirty", "conflict", "ahead"])
    for (const value of [1, null])
      assert.equal(isDormantProject({ ...old, git: { ...old.git, [key]: value } }, {}, now), false);
  // Upstream-only movement (e.g. an unused OSS clone) does not make a project active.
  assert.equal(isDormantProject({ ...old, git: { ...old.git, behind: 1 } }, {}, now), true);
  for (const key of ["active", "waiting_for_user", "blocked", "review_required", "merge_ready"])
    for (const value of [1, null])
      assert.equal(isDormantProject({ ...old, agent_priority_counts: counts({ [key]: value }) }, {}, now), false);
  assert.equal(isDormantProject({ ...old, agent_tasks: null }, {}, now), false);
  assert.equal(isDormantProject(old, null, now), false);
  const task = { project_id: "old", branch: "main", kind: "status", status: "review_required", event_id: "e1", sequence: 1 };
  const waiting = { ...old, agent_tasks: [task], agent_priority_counts: counts({ review_required: 1 }) };
  const { updateAcknowledgements } = await import("../app/agent-acknowledgements.mjs");
  const saved = updateAcknowledgements([task], {}, true);
  assert.equal(isDormantProject(waiting, {}, now), false);
  assert.equal(isDormantProject(waiting, saved, now), true);
  assert.equal(isDormantProject({ ...waiting, agent_tasks: [{ ...task, event_id: "e2" }] }, saved, now), false);
});

test("dormancy URL setting validates and round trips", () => {
  const view = parseHomeUrl("?hideDormant=1").view;
  assert.equal(view.hideDormant, true);
  assert.equal(homeSearch(view), "hideDormant=1");
  assert.equal(parseHomeUrl("").view.hideDormant, false);
  assert.equal(parseHomeUrl("?hideDormant=invalid").view, null);
});

test("card shortcuts ignore editing, dialogs, modifiers and native controls", async () => {
  const { homeCardKeyAction, homeCardIndex } = await import("../app/home-overview.mjs");
  const context = { editing: false, dialogOpen: false, cardFocused: true, interactive: false };
  assert.equal(homeCardKeyAction({ key: "j" }, context), "next");
  assert.equal(homeCardKeyAction({ key: "k" }, context), "previous");
  for (const key of ["Enter", "o"]) {
    assert.equal(homeCardKeyAction({ key }, context), "open");
    assert.equal(homeCardKeyAction({ key }, { ...context, interactive: true }), null);
    assert.equal(homeCardKeyAction({ key }, { ...context, cardFocused: false }), null);
  }
  for (const key of ["/", "?", "K"]) assert.equal(homeCardKeyAction({ key }, context), null);
  for (const flag of ["ctrlKey", "metaKey", "altKey", "shiftKey", "isComposing", "defaultPrevented"])
    assert.equal(homeCardKeyAction({ key: "j", [flag]: true }, context), null);
  for (const flag of ["editing", "dialogOpen"])
    assert.equal(homeCardKeyAction({ key: "j" }, { ...context, [flag]: true }), null);
  assert.equal(homeCardIndex("next", -1, 3), 0);
  assert.equal(homeCardIndex("previous", -1, 3), 2);
  assert.equal(homeCardIndex("next", 0, 3), 1);
  assert.equal(homeCardIndex("next", 2, 3), 2);
  assert.equal(homeCardIndex("previous", 0, 3), 0);
  assert.equal(homeCardIndex("next", -1, 0), null);
});

test("agent報告なしの30日以上前のクリーンなプロジェクトは隠れる", async () => {
  const { isDormantProject } = await import("../app/home-overview.mjs");
  const now = Date.parse("2026-11-16T00:00:00Z");
  const noReports = project("no-reports", {
    latest_event: { date: "2026-10-17T00:00:00Z" },
    agent_tasks: null,
    agent_counts: { running: null, waiting_for_user: null, problem: null, reviewing: null, integratable: null },
    agent_priority_counts: Object.fromEntries(Object.keys(counts()).map((key) => [key, null])),
  });
  assert.equal(isDormantProject(noReports, {}, now), true);
  assert.equal(isDormantProject(noReports, null, now), true);
  assert.equal(isDormantProject(noReports, {}, now - 1), false);
  for (const date of [null, undefined, "invalid"])
    assert.equal(isDormantProject({ ...noReports, latest_event: { date } }, {}, now), false);
  assert.equal(isDormantProject({ ...noReports, latest_event: null }, {}, now), false);
  for (const key of ["dirty", "conflict", "ahead"])
    for (const value of [null, undefined, 1])
      assert.equal(isDormantProject({ ...noReports, git: { ...noReports.git, [key]: value } }, {}, now), false);
  for (const field of ["agent_counts", "agent_priority_counts"]) {
    assert.equal(isDormantProject({ ...noReports, [field]: null }, {}, now), false);
    assert.equal(isDormantProject({ ...noReports, [field]: {} }, {}, now), false);
    const key = Object.keys(noReports[field])[0];
    for (const value of [undefined, 0, 1])
      assert.equal(isDormantProject({ ...noReports, [field]: { ...noReports[field], [key]: value } }, {}, now), false);
  }
});

test("Git取得失敗とfetch失敗は休眠扱いしない", async () => {
  const { isDormantProject } = await import("../app/home-overview.mjs");
  const now = Date.parse("2026-11-16T00:00:00Z");
  const old = project("old", { latest_event: { date: "2026-10-01T00:00:00Z" } });
  assert.equal(isDormantProject({ ...old, git_status_failed: 1 }, {}, now), false);
  assert.equal(isDormantProject({ ...old, fetch_status: { result: "failure" } }, {}, now), false);
});

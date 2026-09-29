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
  ...overrides,
});

const project = (id, overrides = {}) => ({
  id,
  name: id,
  remote: null,
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

test("agent summary totals remain unknown when the authoritative count is unknown", () => {
  const known = project("known", { agent_priority_counts: counts({ active: 2 }) });
  const unknown = project("unknown", { agent_priority_counts: { ...counts(), active: null } });
  assert.equal(agentCount(known, "active"), 2);
  assert.equal(agentCount(unknown, "active"), null);
  assert.deepEqual(aggregateAgentCounts([known, unknown]), {
    waiting_for_user: 0,
    blocked: 0,
    active: null,
    review_required: 0,
    merge_ready: 0,
  });
  assert.equal(hasUnknownAgentCounts(unknown), true);
  assert.equal(countProjectsWithUnknownAgentCounts([known, unknown]), 2);
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

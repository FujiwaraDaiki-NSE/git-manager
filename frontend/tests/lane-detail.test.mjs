import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { agentDecisionReportTimes, agentStateLabel, agentTaskState } from "../app/agent-overview.mjs";
import { laneUpstreamState } from "../app/lane-explorer-tools.mjs";
import { openPullRequestLabels, validHttpUrl } from "../app/pr-tools.mjs";
import { parseProjectUrl, updateProjectUrl } from "../app/project-flow.mjs";
import { missingLocalTrackingRefLabel, upstreamLabel } from "../app/upstream-label.mjs";

const source = readFileSync(new URL("../app/project-control.tsx", import.meta.url), "utf8");
const agentHelpers = source.slice(source.indexOf("function currentLaneAgent("), source.indexOf("function agentElapsed("));
const detailSource = source.slice(source.indexOf("function LaneDetail("), source.indexOf("function CommitDetail("));
const compiled = ts.transpileModule(`${agentHelpers}\nexport ${detailSource}`, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
});
const dependencies = {
  agentDecisionReportTimes, agentStateLabel, agentTaskState, laneUpstreamState, missingLocalTrackingRefLabel, openPullRequestLabels, updateProjectUrl, upstreamLabel, validHttpUrl,
  useSearchParams: () => new URLSearchParams("path=/repo&flowSection=history&range=all&lane=topic"),
  Link: "a",
  laneRecordedMerges: () => ({ incoming: [], outgoing: [] }),
  laneLabel: (lane) => lane.branch,
  laneStateClass: () => "",
  laneState: () => "",
  AgentFact: () => null,
  OperationFacts: () => null,
  DestinationFacts: () => null,
  CommitCompare: ({ laneComparison }) => JSON.stringify(laneComparison),
  exactDate: () => "",
  valueOrUnknown: (value) => value ?? "未取得",
};
const exports = {};
new Function("require", "exports", ...Object.keys(dependencies), compiled.outputText)(
  createRequire(import.meta.url), exports, ...Object.values(dependencies),
);
const lane = {
  id: "topic", branch: "topic", path: null, head: "a".repeat(40), next_command: null,
  next_phase: null, agent: null, default_ahead: 1, default_behind: 1,
  upstream: "origin/topic", upstream_ahead: 1, upstream_behind: 2,
  destinations: { upstream_state: "configured", upstream: "origin/topic", upstream_head: "b".repeat(40) },
};
const render = (changes = {}, project = {}) => renderToStaticMarkup(exports.LaneDetail({
  lane: { ...lane, ...changes }, defaultBranch: "main",
  project: { main_path: "/repo", branch_connections: null, branch_rows: null, agent_events: [], github: {}, ...project },
}));

test("lane comparison uses fixed tips and offers merge-base only when the upstream has diverged", () => {
  assert.match(render(), new RegExp(`&quot;base&quot;:&quot;${lane.destinations.upstream_head}&quot;,&quot;target&quot;:&quot;${lane.head}&quot;`));
  assert.match(render(), /&quot;supportsMergeBase&quot;:true/);
  assert.match(render({ upstream_behind: 0 }), /&quot;supportsMergeBase&quot;:false/);
  assert.match(render({ upstream_ahead: null }), /&quot;supportsMergeBase&quot;:false/);
});

test("lane detail describes a missing tracking ref as a local observation", () => {
  const html = render({ destinations: { ...lane.destinations, upstream_head: null, upstream_gone: true } });
  assert.match(html, /<small>追跡参照がローカルにない<\/small>/);
  assert.doesNotMatch(html, /削除/);
});

test("the lane relation link selects relations and preserves the exact local ref", () => {
  const href = render().match(/href="([^"]+)">現在の包含関係・未解決の記録を確認/)[1].replaceAll("&amp;", "&");
  const url = new URL(href, "http://localhost");
  const state = parseProjectUrl(url.search);
  assert.equal(state.flowSection, "relations");
  assert.equal(state.relationRef, "refs/heads/topic");
  assert.equal(state.lane, null);
  assert.equal(state.range, "all");
  assert.equal(url.hash, "#branch-relations-title");
});

test("lane attention is localized while an explicit next phase keeps priority", () => {
  assert.match(render({ agent: { attention: "waiting_for_user" } }), /次の工程 \/ 注意<\/dt><dd>入力待ち<\/dd>/);
  assert.match(render({ agent: { attention: "review_required" } }), /次の工程 \/ 注意<\/dt><dd>レビュー待ち<\/dd>/);
  assert.match(render({ next_phase: "確認", agent: { attention: "waiting_for_user" } }), /次の工程 \/ 注意<\/dt><dd>確認<\/dd>/);
});

test("lane detail compares its full head with only the open PRs attached to its row", () => {
  const differentHead = `${lane.head.slice(0, -1)}b`;
  const pull = { number: 42, url: "https://github.com/example/repo/pull/42", headRefOid: lane.head, ciState: "SUCCESS", reviewDecision: null };
  const open = { status: "available", checked_at: 1788220800 };
  const attached = { locals: [lane], open_pull_requests: [pull] };
  const project = { github: { open }, branch_rows: [{ locals: [{ id: "other" }], open_pull_requests: [{ ...pull, number: 99 }] }, attached] };
  const same = render({}, project);
  assert.match(same, /先端一致.*CI 成功/);
  assert.doesNotMatch(same, /PR #99/);
  assert.match(same, /照会時刻 <time dateTime="2026-09-01T00:00:00.000Z"/);
  const different = render({ head: differentHead }, project);
  assert.match(different, /先端が異なる.*CI 成功/);
  assert.ok(different.includes(`<code>${differentHead}</code>`) && different.includes(`<code>${lane.head}</code>`));
  assert.match(render({ head: null }, project), /先端を比較できません/);
  assert.match(render({}, { ...project, branch_rows: [{ ...attached, open_pull_requests: [] }] }), /0 件/);
  assert.match(render({}, { ...project, github: { open: { ...open, status: "unavailable" } } }), /オープンPRの照会に失敗しました/);
});

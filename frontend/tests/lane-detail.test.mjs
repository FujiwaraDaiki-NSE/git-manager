import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { agentStateLabel, agentTaskState } from "../app/agent-overview.mjs";
import { laneUpstreamState } from "../app/lane-explorer-tools.mjs";
import { parseProjectUrl, updateProjectUrl } from "../app/project-flow.mjs";
import { upstreamLabel } from "../app/upstream-label.mjs";

const source = readFileSync(new URL("../app/project-control.tsx", import.meta.url), "utf8");
const agentHelpers = source.slice(source.indexOf("function currentLaneAgent("), source.indexOf("function agentElapsed("));
const detailSource = source.slice(source.indexOf("function LaneDetail("), source.indexOf("function CommitDetail("));
const compiled = ts.transpileModule(`${agentHelpers}\nexport ${detailSource}`, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
});
const dependencies = {
  agentStateLabel, agentTaskState, laneUpstreamState, updateProjectUrl, upstreamLabel,
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
const render = (changes = {}) => renderToStaticMarkup(exports.LaneDetail({
  lane: { ...lane, ...changes }, project: { main_path: "/repo", branch_connections: null }, defaultBranch: "main",
}));

test("lane comparison uses fixed tips and offers merge-base only when the upstream has diverged", () => {
  assert.match(render(), new RegExp(`&quot;base&quot;:&quot;${lane.destinations.upstream_head}&quot;,&quot;target&quot;:&quot;${lane.head}&quot;`));
  assert.match(render(), /&quot;supportsMergeBase&quot;:true/);
  assert.match(render({ upstream_behind: 0 }), /&quot;supportsMergeBase&quot;:false/);
  assert.match(render({ upstream_ahead: null }), /&quot;supportsMergeBase&quot;:false/);
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

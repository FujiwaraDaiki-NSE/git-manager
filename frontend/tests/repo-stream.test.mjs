import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as attention from "../app/agent-attention.mjs";
import * as overview from "../app/agent-overview.mjs";
import * as timeline from "../app/agent-timeline-tools.mjs";

function createStream() {
  const requests = [];
  const updates = [];
  const effects = [];
  const timers = [];
  let stream;
  let current;
  const context = { value: null };
  const react = {
    useCallback: (callback) => callback,
    createContext: () => context,
    createElement: (_provider, props) => { current = props.value; },
    useContext: () => context.value,
    useEffect: (effect) => effects.push(effect),
    useRef: (value) => ({ current: value }),
    useState: (initial) => {
      let value = initial;
      return [value, (update) => {
        value = typeof update === "function" ? update(value) : update;
        updates.push(value);
      }];
    },
  };
  class EventSource {
    listeners = {};
    constructor() { stream = this; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    emit(name, value) { this.listeners[name]({ data: JSON.stringify(value) }); }
    close() {}
  }
  const code = ts.transpileModule(readFileSync(new URL("../app/repo-stream.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    require: (name) => name === "react" ? react : name.includes("agent-overview") ? overview : name.includes("agent-attention") ? attention : timeline,
    EventSource, AbortController, URLSearchParams,
    setTimeout: (callback) => { timers.push(callback); return callback; },
    clearTimeout: (callback) => { const index = timers.indexOf(callback); if (index >= 0) timers.splice(index, 1); },
    fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, signal: options.signal, resolve, reject })),
  });
  exports.RepoStreamProvider({ children: null });
  const cleanup = effects[0]();
  return { requests, timers, stream, current, cleanup, updates };
}

test("stream fetches once initially, replays append cursors and pages history without aborting project work", async () => {
  const { requests, timers, stream, current, cleanup } = createStream();
  stream.onopen();
  stream.emit("scan", { active: false });
  assert.deepEqual(requests.map((request) => request.url), ["/api/projects", "/api/agent-events?limit=100"]);
  const rows = Array.from({ length: 100 }, (_, index) => ({ event_id: `e${index}`, sequence: index + 1 }));
  requests[1].resolve({ ok: true, json: async () => ({ events: rows }) });
  await new Promise(setImmediate);
  current.loadOlderEvents();
  assert.equal(requests.at(-1).url, "/api/agent-events?before_sequence=1&limit=100");
  stream.emit("agent_event", { event_id: "live", sequence: 101 });
  stream.onopen();
  assert.equal(requests.at(-1).url, "/api/agent-events?after_sequence=101");
  assert.equal(requests[0].signal.aborted, false);
  stream.emit("scan", { active: true });
  stream.emit("scan", { active: false });
  assert.equal(timers.length, 0);
  assert.equal(requests.filter((request) => request.url === "/api/projects").length, 1);
  requests[0].resolve({ ok: true, json: async () => ({ projects: [] }) });
  await new Promise(setImmediate);
  assert.equal(requests.at(-1).url, "/api/projects");
  assert.equal(requests.filter((request) => request.url.includes("agent-events")).length, 3);
  cleanup();
  assert.equal(requests.at(-1).signal.aborted, true);
});

test("Git changes are subscriber-gated, but an accepted inflight invalidation is retained after unsubscribe", async () => {
  const { requests, timers, stream, current, cleanup } = createStream();
  const flushTimers = () => { while (timers.length > 0) timers.shift()(); };
  const emitChanges = () => {
    stream.emit("repo", { path: "/repo" });
    stream.emit("removed", { path: "/repo" });
  };
  emitChanges();
  assert.equal(timers.length, 0);
  assert.equal(requests.length, 1);
  requests[0].resolve({ ok: true, json: async () => ({ projects: [] }) });
  await new Promise(setImmediate);

  const unsubscribe = current.subscribeProjectsLiveUpdates();
  const unsubscribeSecond = current.subscribeProjectsLiveUpdates();
  emitChanges();
  assert.equal(timers.length, 1);
  flushTimers();
  assert.equal(requests.length, 2);
  unsubscribe();
  emitChanges();
  assert.equal(timers.length, 0);
  assert.equal(requests.length, 2);
  unsubscribeSecond();
  requests[1].resolve({ ok: true, json: async () => ({ projects: [] }) });
  await new Promise(setImmediate);
  assert.equal(requests.length, 3);
  requests[2].resolve({ ok: true, json: async () => ({ projects: [] }) });
  await new Promise(setImmediate);
  emitChanges();
  flushTimers();
  assert.equal(requests.length, 3);
  cleanup();
});

test("100 inflight updates and manual refreshes coalesce into one follow-up, including updates during failure", async () => {
  const { requests, timers, stream, current, cleanup, updates } = createStream();
  current.subscribeProjectsLiveUpdates();
  for (let index = 0; index < 100; index++) {
    stream.emit("repo", { path: `/repo-${index}` });
    current.refreshProjects();
    while (timers.length > 0) timers.shift()();
  }
  assert.equal(requests.length, 1);
  assert.equal(requests[0].signal.aborted, false);
  requests[0].resolve({ ok: true, json: async () => ({ projects: [{ id: "latest", revision: 1, agent_tasks: [] }] }) });
  await new Promise(setImmediate);
  assert.equal(requests.length, 2);
  stream.emit("scan", { active: true });
  stream.emit("scan", { active: false });
  requests[1].reject(new Error("offline"));
  await new Promise(setImmediate);
  assert.equal(requests.length, 3);
  requests[2].resolve({ ok: true, json: async () => ({ projects: [{ id: "latest", revision: 3, agent_tasks: [] }] }) });
  await new Promise(setImmediate);
  const projectUpdates = updates.filter((value) => Array.isArray(value) && value.some((item) => item.id === "latest"));
  assert.equal(projectUpdates.at(-1)[0].revision, 3);
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => !request.signal.aborted));
  cleanup();
});

test("attention subscribes only to new live transitions after initial snapshots and replay", async () => {
  const { requests, stream, current, cleanup } = createStream();
  const notices = [];
  const unsubscribe = current.subscribeAgentAttention((event) => notices.push(event.event_id));
  const event = (sequence, status) => ({ event_id: `attention-${sequence}`, sequence, project_id: "p", branch: "main", kind: "status", status, occurred_at: "2026-11-14T00:00:00Z" });
  stream.onopen();
  stream.emit("agent_event", event(1, "waiting_for_user"));
  requests[0].resolve({ ok: true, json: async () => ({ projects: [{ id: "p", agent_tasks: [event(1, "waiting_for_user")] }] }) });
  requests[1].resolve({ ok: true, json: async () => ({ events: [event(1, "waiting_for_user")] }) });
  await new Promise(setImmediate);
  assert.deepEqual(notices, []);
  stream.emit("agent_event", event(2, "waiting_for_user"));
  stream.emit("agent_event", event(3, "blocked"));
  stream.emit("agent_event", event(3, "blocked"));
  stream.emit("agent_event", event(2, "waiting_for_user"));
  stream.emit("agent_event", event(4, "implementing"));
  stream.emit("agent_event", event(5, "waiting_for_user"));
  assert.deepEqual(notices, ["attention-3", "attention-5"]);
  stream.onopen();
  stream.emit("agent_event", event(6, "blocked"));
  assert.deepEqual(notices, ["attention-3", "attention-5", "attention-6"]);
  requests.at(-1).resolve({ ok: true, json: async () => ({ events: [event(5, "waiting_for_user"), event(6, "blocked")] }) });
  await new Promise(setImmediate);
  assert.equal(notices.length, 3);
  unsubscribe();
  stream.emit("agent_event", event(7, "waiting_for_user"));
  assert.equal(notices.length, 3);
  cleanup();
});

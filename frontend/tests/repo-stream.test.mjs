import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as overview from "../app/agent-overview.mjs";
import * as timeline from "../app/agent-timeline-tools.mjs";

test("stream fetches once initially, replays append cursors, pages history and aborts replacements", async () => {
  const requests = [];
  const effects = [];
  const timers = [];
  let stream;
  let current;
  const context = { value: null };
  const react = {
    createContext: () => context,
    createElement: (_provider, props) => { current = props.value; },
    useContext: () => context.value,
    useEffect: (effect) => effects.push(effect),
    useRef: (value) => ({ current: value }),
    useState: (value) => [value, () => {}],
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
    require: (name) => name === "react" ? react : name.includes("agent-overview") ? overview : timeline,
    EventSource, AbortController, URLSearchParams,
    setTimeout: (callback) => { timers.push(callback); return callback; },
    clearTimeout: (callback) => { const index = timers.indexOf(callback); if (index >= 0) timers.splice(index, 1); },
    fetch: (url, options) => new Promise((resolve) => requests.push({ url, signal: options.signal, resolve })),
  });
  exports.RepoStreamProvider({ children: null });
  const cleanup = effects[0]();
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
  assert.equal(requests.at(-2).url, "/api/agent-events?after_sequence=101");
  assert.equal(requests[0].signal.aborted, true);
  stream.emit("scan", { active: true });
  stream.emit("scan", { active: false });
  timers.shift()();
  assert.equal(requests.at(-1).url, "/api/projects");
  assert.equal(requests.filter((request) => request.url.includes("agent-events")).length, 3);
  cleanup();
  assert.equal(requests.at(-1).signal.aborted, true);
});

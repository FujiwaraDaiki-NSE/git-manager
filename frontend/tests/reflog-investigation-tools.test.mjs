import test from "node:test";
import assert from "node:assert/strict";
import {
  UNKNOWN_ACTOR_FILTER,
  UNKNOWN_OPERATION_KIND_FILTER,
  adjacentReflogRecords,
  deduplicateReflogByHash,
  encodeReflogActor,
  filterReflogInvestigation,
  hasUnknownReflogActor,
  hasUnknownReflogOperation,
  latestReflogOperations,
  reflogActors,
  reflogFilteredJson,
  reflogInvestigationMarkdown,
  reflogOperationKind,
  reflogOperationKinds,
  reflogRecordIdentity,
  sortReflog,
  withReflogRecordIdentities,
} from "../app/reflog-investigation-tools.mjs";

const records = [
  {
    hash: "a".repeat(40),
    selector: "HEAD@{2026-10-03T12:00:00+09:00}",
    message: "checkout: moving from main to feature",
    actor: "Alice <alice@example.test>",
    date: "2026-10-03T12:00:00+09:00",
  },
  {
    hash: "b".repeat(40),
    selector: "HEAD@{2026-10-02T12:00:00+09:00}",
    message: "merge origin/main: Fast-forward",
    actor: "Bob <bob@example.test>",
    date: "2026-10-02T12:00:00+09:00",
  },
  {
    hash: "c".repeat(40),
    selector: "HEAD@{2026-10-01T12:00:00+09:00}",
    message: "pull --ff-only origin main: Fast-forward",
    actor: "Alice <alice@example.test>",
    date: "2026-10-01T12:00:00+09:00",
  },
  {
    hash: "d".repeat(40),
    selector: "HEAD@{2026-09-30T12:00:00+09:00}",
    message: "commit (amend): adjust title",
    actor: null,
    date: "2026-09-30T12:00:00+09:00",
  },
  {
    hash: "e".repeat(40),
    selector: "HEAD@{unknown}",
    message: "metadata without prefix",
    actor: "Alice <alice@example.test>",
    date: null,
  },
];

function options(values = {}) {
  return {
    query: "",
    actorFilter: null,
    operationFilter: null,
    startDate: null,
    endDate: null,
    ...values,
  };
}

test("operation kinds derive from the command prefix and retain commit amend grouping", () => {
  assert.equal(reflogOperationKind(records[0]), "checkout");
  assert.equal(reflogOperationKind(records[1]), "merge");
  assert.equal(reflogOperationKind(records[2]), "pull");
  assert.equal(reflogOperationKind(records[3]), "commit (amend)");
  assert.equal(reflogOperationKind(records[4]), null);
  assert.deepEqual(reflogOperationKinds(records), ["checkout", "commit (amend)", "merge", "pull"]);
  assert.equal(hasUnknownReflogOperation(records), true);
});

test("actor filter uses exact values and exposes unknown actors", () => {
  assert.deepEqual(reflogActors(records), ["Alice <alice@example.test>", "Bob <bob@example.test>"]);
  assert.equal(hasUnknownReflogActor(records), true);
  assert.deepEqual(
    filterReflogInvestigation(records, options({ actorFilter: encodeReflogActor("Alice <alice@example.test>") })).map((record) => record.hash),
    [records[0].hash, records[2].hash, records[4].hash],
  );
  assert.deepEqual(
    filterReflogInvestigation(records, options({ actorFilter: UNKNOWN_ACTOR_FILTER })).map((record) => record.hash),
    [records[3].hash],
  );
  assert.deepEqual(
    filterReflogInvestigation(records, options({ operationFilter: "merge" })).map((record) => record.hash),
    [records[1].hash],
  );
  assert.deepEqual(
    filterReflogInvestigation(records, options({ operationFilter: UNKNOWN_OPERATION_KIND_FILTER })).map((record) => record.hash),
    [records[4].hash],
  );
});

test("investigation conditions remain explicit and date bounds stay inclusive", () => {
  assert.throws(() => filterReflogInvestigation(records, { ...options(), endDate: undefined }), /provided explicitly/);
  assert.deepEqual(filterReflogInvestigation(records, options({ startDate: "2026-10-02", endDate: "2026-10-03" })).map((record) => record.hash), [records[0].hash, records[1].hash]);
  assert.deepEqual(filterReflogInvestigation(records, options({ startDate: "2026-10-04", endDate: "2026-10-02" })), []);
});

test("Git, newest, and oldest ordering is stable and leaves unknown dates last", () => {
  assert.deepEqual(sortReflog(records, "git"), records);
  assert.notStrictEqual(sortReflog(records, "git"), records);
  assert.deepEqual(sortReflog(records, "newest").map((record) => record.hash), [records[0].hash, records[1].hash, records[2].hash, records[3].hash, records[4].hash]);
  assert.deepEqual(sortReflog(records, "oldest").map((record) => record.hash), [records[3].hash, records[2].hash, records[1].hash, records[0].hash, records[4].hash]);
  assert.throws(() => sortReflog(records, "subject"), /Unknown reflog order/);
});

test("latest-per-hash keeps the first Git-order row and does not mutate input", () => {
  const duplicate = { ...records[2], hash: records[0].hash, selector: "HEAD@{2026-10-01T11:00:00+09:00}" };
  const input = [records[0], duplicate, records[1]];
  const reduced = latestReflogOperations(input);
  assert.deepEqual(reduced.map((record) => record.selector), [records[0].selector, records[1].selector]);
  assert.deepEqual(deduplicateReflogByHash(input), reduced);
  assert.deepEqual(input, [records[0], duplicate, records[1]]);
});

test("adjacent navigation follows visible record identities, including duplicate hashes", () => {
  const visible = withReflogRecordIdentities([
    records[0],
    { ...records[1], hash: records[0].hash },
    records[2],
  ]);
  const selected = visible[1].recordId;
  assert.notEqual(visible[0].recordId, visible[1].recordId);
  assert.deepEqual(adjacentReflogRecords(visible, selected), { index: 1, count: 3, previous: visible[0], next: visible[2] });
  assert.deepEqual(adjacentReflogRecords(visible, visible[0].recordId).next, visible[1]);
  assert.deepEqual(adjacentReflogRecords(visible, null), { index: -1, count: 3, previous: null, next: null });
  assert.throws(() => adjacentReflogRecords(visible), /provided explicitly/);
});

test("selected operation Markdown carries exact ref metadata and escapes content", () => {
  const selected = { ...records[0], recordId: "reflog-record:0", message: "checkout: title | <unsafe>\nnext" };
  const markdown = reflogInvestigationMarkdown(selected, "/repo/<unsafe>", "refs/heads/main");
  assert.match(markdown, /repository_path: \/repo\/&lt;unsafe&gt;/);
  assert.match(markdown, /ref: refs\/heads\/main/);
  assert.match(markdown, /record_id: reflog-record:0/);
  assert.match(markdown, /operation_kind: checkout/);
  assert.match(markdown, /message: checkout: title \\\| &lt;unsafe&gt;<br>next/);
  assert.ok(markdown.includes("read_only: true"));
  assert.equal(markdown.includes("<unsafe>"), false);
});

test("filtered JSON includes ref metadata, identities, derived kind, and only supplied records", () => {
  const selected = withReflogRecordIdentities(records.slice(0, 2));
  const value = JSON.parse(reflogFilteredJson({
    path: "/repo/project",
    ref: "HEAD",
    records: [selected[1]],
    available: true,
    truncated: false,
  }));
  assert.deepEqual(value, {
    repository_path: "/repo/project",
    ref: "HEAD",
    available: true,
    truncated: false,
    record_count: 1,
    records: [{
      record_id: selected[1].recordId,
      hash: selected[1].hash,
      selector: selected[1].selector,
      message: selected[1].message,
      operation_kind: "merge",
      actor: selected[1].actor,
      date: selected[1].date,
    }],
    read_only: true,
  });
  assert.throws(() => reflogFilteredJson({ path: "/repo", ref: "main", records: [], available: true, truncated: false }), /explicit/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { laneRecordedMerges } from "../app/lane-relations.mjs";

test("local FF is visible while a PR on its remote stays a separate fact", () => {
  const ff = { kind: "merge", source_ref_id: "refs/heads/quantity", target_ref_id: "refs/heads/ui" };
  const pr = { kind: "merge", source_ref_id: "refs/heads/other", target_ref_id: "refs/remotes/origin/ui" };
  const unknown = { kind: "merge", source_ref_id: null, target_ref_id: null, target_row_id: "remote:origin/ui" };
  const connection = { edges: [ff, pr, unknown] };
  assert.deepEqual(laneRecordedMerges(connection, { branch: "ui" }), { incoming: [ff], outgoing: [] });
  assert.deepEqual(laneRecordedMerges(connection, { branch: "quantity" }), { incoming: [], outgoing: [ff] });
  assert.deepEqual(laneRecordedMerges(connection, { branch: null }), { incoming: [], outgoing: [] });
});

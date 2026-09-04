import test from "node:test";
import assert from "node:assert/strict";
import {
  bumpProjectRevisions,
  revisionKeysForEvent,
} from "../app/project-revision.mjs";

const repos = new Map([
  ["/repo/main", { common_dir: "/repo" }],
  ["/other/main", { common_dir: "/other" }],
]);

test("repo events only invalidate their own common project", () => {
  const selection = { type: "project", commonDir: "/repo" };
  const keys = revisionKeysForEvent(
    { type: "repo", repo: { path: "/other/main", common_dir: "/other" } },
    selection,
    repos,
  );
  const next = bumpProjectRevisions(new Map([["/repo", 4]]), keys);

  assert.deepEqual(keys, ["/other"]);
  assert.equal(next.get("/repo"), 4);
  assert.equal(next.get("/other"), 1);
});

test("selected project receives one key for snapshot, removal, and scan completion", () => {
  const selection = { type: "project", commonDir: "/repo" };
  assert.deepEqual(
    revisionKeysForEvent({ type: "snapshot" }, selection, repos),
    ["/repo"],
  );
  assert.deepEqual(
    revisionKeysForEvent({ type: "removed", path: "/repo/main" }, selection, repos),
    ["/repo"],
  );
  assert.deepEqual(
    revisionKeysForEvent({ type: "scan-complete" }, selection, repos),
    ["/repo"],
  );
  assert.deepEqual(
    revisionKeysForEvent({ type: "removed", path: "/missing" }, selection, repos),
    [],
  );
});

test("duplicate events are coalesced before bumping a project revision", () => {
  const next = bumpProjectRevisions(
    new Map([["/repo", 2]]),
    ["/repo", "/repo", "/repo"],
  );
  assert.equal(next.get("/repo"), 3);
});

import test from "node:test";
import assert from "node:assert/strict";
import { projectSnapshotFreshness } from "../app/agent-attention.mjs";
import { countOldActiveReports } from "../app/home-overview.mjs";

test("Git情報は照合済み・更新中・失敗を区別する", () => {
  const now = 24 * 3600 * 1000;
  const snapshot = { observed_at: 3600, error: "失敗理由" };
  assert.equal(projectSnapshotFreshness({ ...snapshot, status: "ready" }, now), "Git情報：最新（23時間前から変化なし）");
  assert.equal(projectSnapshotFreshness({ ...snapshot, status: "refreshing" }, now), "Git情報：更新中（23時間前の状態を表示）");
  assert.equal(projectSnapshotFreshness({ ...snapshot, status: "failed" }, now), "Git情報の取得：23時間前 · 更新失敗：失敗理由");
});

test("実行中の古い報告だけを24時間境界を含め数え、時刻不明は推測しない", () => {
  const now = Date.parse("2026-11-19T00:00:00Z");
  const task = (status, occurred_at) => ({ kind: "status", status, occurred_at });
  const old = "2026-11-18T00:00:00Z";
  assert.equal(countOldActiveReports([{ agent_tasks: [
    ...["investigating", "implementing", "testing", "reviewing"].map(status => task(status, old)),
    task("implementing", "2026-11-18T00:00:00.001Z"),
    task("completed", old), task("waiting_for_user", old),
    task("implementing", null), task("testing", "invalid"),
  ] }, { agent_tasks: null }], now), 4);
  assert.equal(countOldActiveReports([], now), 0);
});

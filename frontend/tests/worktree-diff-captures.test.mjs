import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKTREE_DIFF_CAPTURE_LIMIT,
  appendWorktreeDiffCapture,
  buildWorktreeDiffCaptureJson,
  buildWorktreeDiffCaptureMarkdown,
  buildWorktreeExcludedJsonl,
  captureWorktreeDiff,
  compareWorktreeDiffCaptures,
  filterWorktreeExclusions,
  worktreeExclusionRows,
} from "../app/worktree-diff-capture-tools.mjs";

const request = { path: "/repo with space", stage: "unstaged", file: null, ignoreWhitespace: false };
const file = (path, additions, deletions, extra = {}) => ({ path, additions, deletions, binary: false, ...extra });

function response(files, overrides = {}) {
  return {
    stage: "unstaged", stage_label: "未ステージ", file: null, ignore_whitespace: false,
    input: { stage: "unstaged", file: null, ignore_whitespace: false },
    snapshot: { stage: "unstaged", stage_label: "未ステージ", file: null, scope: "all", ignore_whitespace: false },
    scope: "all", files, stats: { files: files.length, additions: 2, deletions: 1, binary: 0, renamed: 0 },
    patch: "diff --git a/a.txt b/a.txt\n-old\n+new\n", patch_complete: true, patch_truncated: false,
    patch_bytes: 40, patch_limit_bytes: 1048576, metadata_complete: true,
    excluded: { untracked: [], conflict: [], not_in_diff: [] },
    command: "git -C '/repo with space' diff --", ...overrides,
  };
}

function capture(id, data) {
  return captureWorktreeDiff(id, request, data, `2026-11-10T00:00:0${id}.000Z`);
}

test("capture exports preserve received evidence, exact request, unknown counts and partial coverage", () => {
  const data = response([file("image.bin", "-", "-", { binary: true })], {
    stats: { files: 1, additions: null, deletions: null, binary: 1, renamed: 0 },
    patch: "partial patch", patch_complete: false, patch_truncated: true,
    excluded: { untracked: [], conflict: ["conflict\nname"], not_in_diff: [] },
  });
  const observed = capture(1, data);
  const exported = JSON.parse(buildWorktreeDiffCaptureJson(observed));
  assert.equal(exported.schema, "gitdash.worktree-diff.capture.v1");
  assert.equal(exported.repository_path, request.path);
  assert.equal(exported.response_received_at, "2026-11-10T00:00:01.000Z");
  assert.deepEqual(exported.request, request);
  assert.deepEqual(exported.response, data);
  assert.equal(exported.response.stats.additions, null);
  assert.equal(exported.response.patch_complete, false);
  assert.match(buildWorktreeDiffCaptureMarkdown(observed), /部分（上限による切り詰め）/);
  assert.match(buildWorktreeDiffCaptureMarkdown(observed), /追加行（既知） 不明/);
});

test("capture validation rejects absent inputs and mismatched authoritative request scope", () => {
  const data = response([]);
  assert.throws(() => captureWorktreeDiff(1, { ...request, file: undefined }, data, "2026-11-10T00:00:00Z"), TypeError);
  assert.throws(() => capture(1, { ...data, input: { ...data.input, ignore_whitespace: true } }), TypeError);
  assert.throws(() => capture(1, { ...data, snapshot: { ...data.snapshot, scope: "file" } }), TypeError);
  assert.throws(() => capture(1, { ...data, metadata_complete: undefined }), TypeError);
  assert.throws(() => capture(1, { ...data, files: [file("same", 1, 0), file("same", 2, 0)] }), TypeError);
  assert.throws(() => capture(1, { ...data, patch_complete: false }), TypeError);
  assert.throws(() => captureWorktreeDiff(1, request, data, "invalid"), TypeError);
});

test("history retains five received captures in newest-first order without conflating scope", () => {
  let history = [];
  for (let id = 1; id <= 7; id += 1) history = appendWorktreeDiffCapture(history, capture(id, response([])));
  assert.equal(WORKTREE_DIFF_CAPTURE_LIMIT, 5);
  assert.deepEqual(history.map((item) => item.id), [7, 6, 5, 4, 3]);
  assert.equal(history[history.length - 1].received_at, "2026-11-10T00:00:03.000Z");
  const otherRequest = { ...request, path: "/different/repo" };
  const other = captureWorktreeDiff(8, otherRequest, response([]), "2026-11-10T00:00:08.000Z");
  assert.throws(() => compareWorktreeDiffCaptures(history[0], other), /same explicit request/);
});

test("excluded inventory uses API reported reason and literal path matching including unusual names", () => {
  const rows = worktreeExclusionRows({ untracked: ["new.log"], conflict: ["src/[a].TXT", "line\nname.txt"], not_in_diff: ["old.txt"] });
  assert.deepEqual(filterWorktreeExclusions(rows, "conflict", "[A].txt"), [{ path: "src/[a].TXT", reason: "conflict" }]);
  assert.deepEqual(filterWorktreeExclusions(rows, "all", "line\n"), [{ path: "line\nname.txt", reason: "conflict" }]);
  assert.equal(filterWorktreeExclusions(rows, "untracked", "txt").length, 0);
  assert.throws(() => worktreeExclusionRows({ conflict: [] }), TypeError);
  assert.throws(() => filterWorktreeExclusions(rows, undefined, ""), RangeError);
  assert.throws(() => filterWorktreeExclusions(rows, "all", undefined), TypeError);
});

test("filtered excluded JSONL includes safe exact paths, reasons, capture context and conditions", () => {
  const observed = capture(1, response([], { excluded: { untracked: ["private.log"], conflict: ["line\nname.txt", "quote\".txt"], not_in_diff: [] } }));
  const jsonl = buildWorktreeExcludedJsonl(observed, "conflict", "txt");
  const lines = jsonl.split("\n");
  assert.equal(lines.length, 2);
  const exported = lines.map((line) => JSON.parse(line));
  assert.deepEqual(exported.map((item) => item.path), ["line\nname.txt", "quote\".txt"]);
  assert.ok(exported.every((item) => item.reason === "conflict" && item.repository_path === request.path && item.capture_id === 1));
  assert.deepEqual(exported[0].filters, { reason: "conflict", query: "txt" });
  assert.deepEqual(exported[0].request, request);
  assert.equal(buildWorktreeExcludedJsonl(observed, "not_in_diff", ""), "");
});

test("Markdown safely fences command, unusual scope and patches containing backtick runs", () => {
  const patch = "+```\n+````\n+text";
  const observed = capture(1, response([file("line\nname.txt", 2, 1)], { patch, command: "git diff -- 'name```'" }));
  const report = buildWorktreeDiffCaptureMarkdown(observed);
  assert.ok(report.includes("`````diff\n" + patch + "\n`````"));
  assert.match(report, /line\\nname\.txt/);
  assert.ok(report.includes("````sh\ngit diff -- 'name```'\n````"));
  assert.match(report, /現在のファイル状態やコミットの同一性は保証しません/);
  assert.doesNotThrow(() => buildWorktreeDiffCaptureMarkdown(capture(2, response([], { patch: "+` ".repeat(150000) }))));
});

test("tracked comparison distinguishes entering, leaving, renamed metadata, unknown lines and unchanged counts with changed text", () => {
  const before = capture(1, response([file("left.txt", 1, 0), file("same.txt", 2, 1), file("rename.txt", 1, 0, { old_path: "old.txt" }), file("binary.bin", "-", "-", { binary: true })]));
  const after = capture(2, response([file("entered.txt", 3, 0), file("same.txt", 2, 1), file("rename.txt", 1, 0, { old_path: "other.txt" }), file("binary.bin", 1, 0)], { patch: "different text with same counts" }));
  const compared = compareWorktreeDiffCaptures(before, after);
  assert.deepEqual(compared.files.map(({ path, kind }) => [path, kind]), [["binary.bin", "metadata_changed"], ["entered.txt", "entered"], ["left.txt", "left"], ["rename.txt", "metadata_changed"]]);
  assert.equal(compared.files[0].before.additions, "-");
  assert.equal(compared.files[1].before, null);
  assert.equal(compared.files[2].after, null);
  assert.equal(compared.patch_comparison, "different");
  const countsUnchanged = compareWorktreeDiffCaptures(before, capture(3, { ...before.response, patch: "new text" }));
  assert.deepEqual(countsUnchanged.files, []);
  assert.equal(countsUnchanged.patch_comparison, "different");
});

test("comparison never treats missing incomplete inventory or truncated patch suffix as equality", () => {
  const before = capture(1, response([file("tracked.txt", 2, 0)]));
  const incomplete = capture(2, response([], { metadata_complete: false, patch_complete: false, patch_truncated: true }));
  const compared = compareWorktreeDiffCaptures(before, incomplete);
  assert.equal(compared.metadata_complete, false);
  assert.deepEqual(compared.files, []);
  assert.equal(compared.patch_comparison, "same_prefix");
  assert.equal(compareWorktreeDiffCaptures(before, capture(3, response([], { patch: "new prefix", patch_complete: false, patch_truncated: true }))).patch_comparison, "different_prefix");
  assert.equal(compareWorktreeDiffCaptures(before, capture(4, before.response)).patch_comparison, "same");
});

test("excluded transitions report entered, absent and changed reason without claiming resolution", () => {
  const before = capture(1, response([], { excluded: { untracked: ["changed.txt"], conflict: ["left.txt", "stable.txt"], not_in_diff: [] } }));
  const after = capture(2, response([], { excluded: { untracked: [], conflict: ["changed.txt", "stable.txt"], not_in_diff: ["entered.txt"] } }));
  const compared = compareWorktreeDiffCaptures(before, after);
  assert.deepEqual(compared.exclusions, [
    { path: "changed.txt", kind: "reason_changed", before: ["untracked"], after: ["conflict"] },
    { path: "entered.txt", kind: "entered", before: [], after: ["not_in_diff"] },
    { path: "left.txt", kind: "left", before: ["conflict"], after: [] },
  ]);
});

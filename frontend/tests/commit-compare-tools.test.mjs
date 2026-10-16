import test from "node:test";
import assert from "node:assert/strict";
import {
  buildComparisonFilesCsv,
  buildComparisonQuery,
  comparisonModeLabel,
  comparisonPatchDownloadName,
  comparisonPatchDownloadStatus,
  comparisonReproductionCommand,
  escapeComparisonSpreadsheetFormula,
  swapComparisonValues,
} from "../app/commit-compare-tools.mjs";

test("comparison requests require explicit path, refs, and mode", () => {
  const query = buildComparisonQuery("/tmp/repo", "refs/heads/main", "abc123", "direct");
  const params = new URLSearchParams(query);
  assert.equal(params.get("path"), "/tmp/repo");
  assert.equal(params.get("base"), "refs/heads/main");
  assert.equal(params.get("target"), "abc123");
  assert.equal(params.get("mode"), "direct");
  assert.throws(() => buildComparisonQuery("/tmp/repo", "", "target", "direct"), RangeError);
  assert.throws(() => buildComparisonQuery("/tmp/repo", "base", "target", ""), RangeError);
});

test("swapping comparison values preserves the input context", () => {
  const values = { base: "base-hash", target: "target-hash", mode: "merge-base" };
  assert.deepEqual(swapComparisonValues(values), {
    base: "target-hash",
    target: "base-hash",
    mode: "merge-base",
  });
});

test("comparison inventory CSV quotes paths and protects formula-looking values", () => {
  const csv = buildComparisonFilesCsv([
    { path: "=HYPERLINK(\"https://example.test\")", old_path: "+old,name", additions: 2, deletions: 1, binary: false },
    { path: "assets/logo.png", additions: "-", deletions: "-", binary: true },
  ]);
  assert.match(csv, /^path,oldpath,additions,deletions,binary\r\n/);
  assert.match(csv, /'=HYPERLINK\(""https:\/\/example\.test""\)/);
  assert.match(csv, /"'\+old,name",2,1,false/);
  assert.match(csv, /assets\/logo\.png,,unknown,unknown,true/);
});

test("CSV formula protection handles whitespace and BOM before an operator", () => {
  for (const value of [" =1+1", "\t+SUM(A1)", "\n@cmd", "\uFEFF=1+1", " \uFEFF-1"]) {
    assert.equal(escapeComparisonSpreadsheetFormula(value), `'${value}`);
  }
  assert.equal(escapeComparisonSpreadsheetFormula(" plain text"), " plain text");
});

test("reproduction commands include a safely quoted host path and preserve backend hashes", () => {
  const command = "git -c core.quotepath=false diff --no-ext-diff abc123 def456 --";
  assert.equal(
    comparisonReproductionCommand("/tmp/it's repo/$()", command),
    "git -C '/tmp/it'\\''s repo/$()' -c core.quotepath=false diff --no-ext-diff abc123 def456 --",
  );
  assert.throws(() => comparisonReproductionCommand("/tmp/repo", "git\nrm -rf ."), RangeError);
});

test("partial downloads are named and described as partial", () => {
  const comparison = { base: "a".repeat(40), target: "b".repeat(40), patch_truncated: true };
  assert.equal(comparisonPatchDownloadName(comparison), `${"a".repeat(12)}-${"b".repeat(12)}-partial.patch`);
  assert.match(comparisonPatchDownloadStatus(true), /部分/);
  assert.match(comparisonPatchDownloadStatus(false), /完全/);
  assert.equal(comparisonModeLabel("merge-base"), "共通祖先（merge-base）から比較");
});

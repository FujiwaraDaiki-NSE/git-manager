import test from "node:test";
import assert from "node:assert/strict";
import {
  REPOSITORY_TEXT_MAX_PREVIEW_BYTES,
  boundedRepositoryText,
  findRepositoryTextMatches,
  parseRepositoryLineNumber,
  repositoryTextLineAtOffset,
  repositoryTextRange,
  splitRepositoryText,
  validateRepositoryTextRange,
  visibleRepositoryWhitespace,
} from "../app/repository-text-tools.mjs";

test("text previews stay within the explicit UTF-8 byte cap", () => {
  const text = "あ".repeat(REPOSITORY_TEXT_MAX_PREVIEW_BYTES);
  const bounded = boundedRepositoryText(text, REPOSITORY_TEXT_MAX_PREVIEW_BYTES);
  assert.ok(new TextEncoder().encode(bounded).byteLength <= REPOSITORY_TEXT_MAX_PREVIEW_BYTES);
  assert.equal(bounded.at(-1), "あ");
  assert.throws(() => boundedRepositoryText("value"), /maxBytes/);
});

test("line splitting keeps CRLF and exact raw offsets for range copying", () => {
  const text = "first\r\nsecond\n\nlast";
  const lines = splitRepositoryText(text);
  assert.deepEqual(lines.map((line) => [line.number, line.text, line.ending]), [
    [1, "first", "\r\n"],
    [2, "second", "\n"],
    [3, "", "\n"],
    [4, "last", ""],
  ]);
  assert.equal(repositoryTextLineAtOffset(lines, 0), 1);
  assert.equal(repositoryTextLineAtOffset(lines, 7), 2);
  assert.equal(repositoryTextRange(text, "2", "3")?.text, "second\n\n");
  assert.equal(repositoryTextRange(text, "4", "4")?.text, "last");
});

test("line and range inputs require explicit valid endpoints", () => {
  assert.equal(parseRepositoryLineNumber("", 4), null);
  assert.equal(parseRepositoryLineNumber("0", 4), null);
  assert.equal(parseRepositoryLineNumber("5", 4), null);
  assert.equal(parseRepositoryLineNumber("2.0", 4), null);
  assert.equal(parseRepositoryLineNumber("2", 4), 2);
  assert.deepEqual(validateRepositoryTextRange("2", "4", 4), { start: 2, end: 4 });
  assert.equal(validateRepositoryTextRange("", "4", 4), null);
  assert.equal(validateRepositoryTextRange("4", "2", 4), null);
  assert.equal(validateRepositoryTextRange("2", "", 4), null);
});

test("literal search escapes regex syntax and supports optional case sensitivity", () => {
  const text = "A+B a+b A+B";
  assert.deepEqual(findRepositoryTextMatches(text, "a+b", false).map(({ offset, length }) => [offset, length]), [[0, 3], [4, 3], [8, 3]]);
  assert.deepEqual(findRepositoryTextMatches(text, "a+b", true).map(({ offset, length }) => [offset, length]), [[4, 3]]);
  assert.deepEqual(findRepositoryTextMatches("needle needle", "needle", true), [
    { offset: 0, length: 6, end: 6 },
    { offset: 7, length: 6, end: 13 },
  ]);
  assert.throws(() => findRepositoryTextMatches(text, "a+b"), /caseSensitive/);
});

test("whitespace visibility changes only the visual string", () => {
  const raw = "  key\tvalue";
  assert.equal(visibleRepositoryWhitespace(raw, false), raw);
  assert.equal(visibleRepositoryWhitespace(raw, true), "··key⇥value");
  assert.throws(() => visibleRepositoryWhitespace(raw), /visible/);
});

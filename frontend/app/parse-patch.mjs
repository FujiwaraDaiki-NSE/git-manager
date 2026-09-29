/**
 * Preserve every patch line; only assign line numbers inside ordinary unified hunks.
 * @param {string} patch
 * @returns {Array<{title: string, lines: Array<{text: string, kind: string, oldLine: number | null, newLine: number | null}>}>}
 */
export function parsePatch(patch) {
  if (patch === "") return [];
  const sections = [];
  let section = null;
  let oldLine = null;
  let newLine = null;
  let oldRemaining = 0;
  let newRemaining = 0;
  for (const text of patch.split("\n")) {
    if (/^diff --(?:git|cc|combined) /.test(text)) {
      const samePath = text.match(/^diff --git a\/(.+) b\/\1$/);
      section = { title: samePath ? samePath[1] : text.replace(/^diff --(?:git|cc|combined) /, ""), lines: [] };
      sections.push(section);
      oldLine = newLine = null;
      oldRemaining = newRemaining = 0;
    }
    if (section === null) {
      section = { title: "差分", lines: [] };
      sections.push(section);
    }
    const line = { text, kind: "meta", oldLine: null, newLine: null };
    const hunk = text.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      oldRemaining = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newRemaining = hunk[4] === undefined ? 1 : Number(hunk[4]);
      line.kind = "hunk";
    } else if (text.startsWith("@@@")) {
      // Combined merge diffs have one column per parent, not a two-file mapping.
      oldLine = newLine = null;
      oldRemaining = newRemaining = 0;
      line.kind = "hunk";
    } else if (oldLine !== null && newLine !== null && (oldRemaining > 0 || newRemaining > 0)) {
      if (text.startsWith("+") && newRemaining > 0) {
        line.kind = "addition";
        line.newLine = newLine++;
        newRemaining--;
      } else if (text.startsWith("-") && oldRemaining > 0) {
        line.kind = "deletion";
        line.oldLine = oldLine++;
        oldRemaining--;
      } else if (text.startsWith(" ") && oldRemaining > 0 && newRemaining > 0) {
        line.kind = "context";
        line.oldLine = oldLine++;
        line.newLine = newLine++;
        oldRemaining--;
        newRemaining--;
      }
    }
    section.lines.push(line);
  }
  return sections;
}

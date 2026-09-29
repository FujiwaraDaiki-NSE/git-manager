const conflictCodes = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
const changeCodes = new Set(["A", "M", "D", "R", "C", "T"]);
const labels = { A: "追加", M: "変更", D: "削除", R: "名前変更", C: "コピー", T: "種類変更" };

export function fileStatusGroups(xy) {
  const conflict = conflictCodes.has(xy);
  return {
    all: true,
    staged: !conflict && changeCodes.has(xy[0]),
    unstaged: !conflict && changeCodes.has(xy[1]),
    untracked: xy === "??",
    conflict,
  };
}

export function fileStatusDescription(xy) {
  if (xy === "??") return "未追跡";
  if (conflictCodes.has(xy)) return "競合を解消してください";
  const parts = [];
  if (changeCodes.has(xy[0])) parts.push(`ステージ: ${labels[xy[0]]}`);
  if (changeCodes.has(xy[1])) parts.push(`作業: ${labels[xy[1]]}`);
  return parts.length ? parts.join(" / ") : `状態: ${xy}`;
}

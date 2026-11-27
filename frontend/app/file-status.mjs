const conflictDescriptions = new Map([
  ["DD", "双方で削除"],
  ["AU", "こちら側で追加"],
  ["UD", "相手側で削除"],
  ["UA", "相手側で追加"],
  ["DU", "こちら側で削除"],
  ["AA", "双方で追加"],
  ["UU", "双方で変更"],
]);
const changeCodes = new Set(["A", "M", "D", "R", "C", "T"]);
const labels = { A: "追加", M: "変更", D: "削除", R: "名前変更", C: "コピー", T: "種類変更" };

export function fileStatusGroups(xy) {
  const conflict = conflictDescriptions.has(xy);
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
  if (conflictDescriptions.has(xy)) return conflictDescriptions.get(xy);
  const parts = [];
  if (changeCodes.has(xy[0])) parts.push(`ステージ: ${labels[xy[0]]}`);
  if (changeCodes.has(xy[1])) parts.push(`作業: ${labels[xy[1]]}`);
  return parts.length ? parts.join(" / ") : `状態: ${xy}`;
}

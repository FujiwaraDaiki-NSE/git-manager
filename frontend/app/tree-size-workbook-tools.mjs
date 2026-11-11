/** @typedef {{path:string, mode:string, type:string, hash:string, size:number|null}} Entry */
/** @param {string} text */
export function optionalWholeNumber(text) {
  if (text === "") return { value: null, error: null };
  if (!/^\d+$/u.test(text) || !Number.isSafeInteger(Number(text)))
    return { value: null, error: "0以上の安全な整数を指定してください。" };
  return { value: Number(text), error: null };
}
/** @param {Entry[]} entries @param {{exclude:string, mode:string|null, hash:string, depth:number|null, extension:string|null, hideReviewed:boolean}} filters @param {Set<string>} reviewed */
export function workbookEntries(entries, filters, reviewed) {
  return entries.filter(
    (e) =>
      (filters.exclude === "" ||
        !e.path.toLowerCase().includes(filters.exclude.toLowerCase())) &&
      (filters.mode === null || e.mode === filters.mode) &&
      (filters.hash === "" ||
        e.hash.toLowerCase() === filters.hash.toLowerCase()) &&
      (filters.depth === null ||
        e.path.split("/").length - 1 <= filters.depth) &&
      (filters.extension === null ||
        workbookExtension(e.path) === filters.extension) &&
      (!filters.hideReviewed || !reviewed.has(e.path)),
  );
}
/** @param {string} path */
export function workbookExtension(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}
/** @param {Entry[]} entries */
export function workbookExtensions(entries) {
  /** @type {Map<string,{extension:string,count:number,bytes:number,unknown:number}>} */
  const groups = new Map();
  for (const e of entries) {
    const extension = workbookExtension(e.path);
    let group = groups.get(extension);
    if (!group) {
      group = { extension, count: 0, bytes: 0, unknown: 0 };
      groups.set(extension, group);
    }
    group.count++;
    if (e.size === null) group.unknown++;
    else group.bytes += e.size;
  }
  return [...groups.values()].sort(
    (a, b) => b.bytes - a.bytes || a.extension.localeCompare(b.extension),
  );
}
/** @param {Entry[]} entries */
export function workbookDuplicates(entries) {
  /** @type {Map<string,Entry[]>} */
  const groups = new Map();
  for (const e of entries) {
    const key = `${e.type}:${e.hash}`;
    const rows = groups.get(key);
    if (rows) rows.push(e);
    else groups.set(key, [e]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}
/** @param {Entry[]} entries @param {number} count */
export function workbookCoverage(entries, count) {
  const known = entries
    .filter((e) => e.size !== null)
    .sort(
      (a, b) =>
        /** @type {number} */ (b.size) - /** @type {number} */ (a.size) ||
        a.path.localeCompare(b.path),
    );
  const total = known.reduce((n, e) => n + /** @type {number} */ (e.size), 0);
  const largest = known.slice(0, count);
  const bytes = largest.reduce((n, e) => n + /** @type {number} */ (e.size), 0);
  return {
    largest,
    bytes,
    total,
    percent: total === 0 ? null : (bytes / total) * 100,
    unknown: entries.length - known.length,
  };
}
/** Null deltas mean unknown, never zero. Only matching paths are compared; renamed paths appear as removed/added. */
/** @param {Entry[]} before @param {Entry[]} after */
export function workbookDelta(before, after) {
  const old = new Map(before.map((e) => [e.path, e]));
  const next = new Map(after.map((e) => [e.path, e]));
  return [...new Set([...old.keys(), ...next.keys()])]
    .sort()
    .flatMap((path) => {
      const a = old.get(path);
      const b = next.get(path);
      if (
        a &&
        b &&
        a.hash === b.hash &&
        a.type === b.type &&
        a.mode === b.mode &&
        a.size === b.size
      )
        return [];
      return [
        {
          path,
          kind: !a ? "追加" : !b ? "削除" : "変更",
          before: a ?? null,
          after: b ?? null,
          delta:
            (a && a.size === null) || (b && b.size === null)
              ? null
              : (b ? /** @type {number} */ (b.size) : 0) -
                (a ? /** @type {number} */ (a.size) : 0),
        },
      ];
    });
}
/** @param {string} path @param {{revision:string,pinned_hash:string,truncated:boolean}} inventory @param {Entry[]} entries @param {object} conditions */
export function workbookMarkdown(path, inventory, entries, conditions) {
  const known = entries.reduce((n, e) => n + (e.size === null ? 0 : e.size), 0);
  return [
    "# ファイル容量の調査記録",
    "",
    `リポジトリ: ${JSON.stringify(path)}`,
    `revision: ${JSON.stringify(inventory.revision)}`,
    `固定コミット: ${inventory.pinned_hash}`,
    `取得上限による省略: ${inventory.truncated ? "あり（部分集計）" : "なし"}`,
    `対象: ${entries.length} path / 既知サイズ合計: ${known} B / 不明: ${entries.filter((e) => e.size === null).length} path`,
    "パスの参照容量です。ディスク使用量・削減可能容量ではありません。",
    "",
    "## 表示条件",
    "",
    "```json",
    JSON.stringify(conditions, null, 2),
    "```",
    "",
    "## パス",
    "",
    "```json",
    JSON.stringify(entries, null, 2),
    "```",
    "",
  ].join("\n");
}

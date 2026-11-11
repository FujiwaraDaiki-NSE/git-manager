"use client";
import { useMemo, useState } from "react";
import CopyButton from "./copy-button";
import { treeSizesCsv, formatTreeSizeBytes } from "./tree-sizes-tools.mjs";
import {
  optionalWholeNumber,
  workbookEntries,
  workbookExtensions,
  workbookDuplicates,
  workbookCoverage,
  workbookDelta,
  workbookMarkdown,
} from "./tree-size-workbook-tools.mjs";
import "./tree-size-workbook.css";

type Entry = {
  path: string;
  mode: string;
  type: string;
  hash: string;
  size: number | null;
};
type Inventory = {
  revision: string;
  pinned_hash: string;
  entries: Entry[];
  truncated: boolean;
  limit: number;
  byte_limit: number;
};
function download(value: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function TreeSizeWorkbook({
  path,
  inventory,
  entries,
  conditions,
}: {
  path: string;
  inventory: Inventory;
  entries: Entry[];
  conditions: object;
}) {
  const [exclude, setExclude] = useState("");
  const [mode, setMode] = useState<string | null>(null);
  const [hash, setHash] = useState("");
  const [depth, setDepth] = useState("");
  const [extension, setExtension] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  const [hideReviewed, setHideReviewed] = useState(false);
  const [budget, setBudget] = useState("");
  const [top, setTop] = useState("10");
  const [baseline, setBaseline] = useState<Inventory | null>(null);
  const [baselineRevision, setBaselineRevision] = useState("");
  const [baselineState, setBaselineState] = useState("");
  const [busy, setBusy] = useState(false);
  const depthValue = optionalWholeNumber(depth);
  const budgetValue = optionalWholeNumber(budget);
  const topValue = optionalWholeNumber(top);
  const invalidHash =
    hash !== "" && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(hash);
  const filters = {
    exclude,
    mode,
    hash,
    depth: depthValue.value,
    extension,
    hideReviewed,
  };
  const visible = useMemo(
    () =>
      depthValue.error || invalidHash
        ? []
        : workbookEntries(
            entries,
            {
              exclude,
              mode,
              hash,
              depth: depthValue.value,
              extension,
              hideReviewed,
            },
            reviewed,
          ),
    [
      entries,
      exclude,
      mode,
      hash,
      depthValue.value,
      depthValue.error,
      extension,
      hideReviewed,
      reviewed,
      invalidHash,
    ],
  );
  const totalPages = Math.max(1, Math.ceil(visible.length / pageSize));
  const currentPage = Math.min(page, totalPages - 1);
  const paged = visible.slice(
    currentPage * pageSize,
    (currentPage + 1) * pageSize,
  );
  const selectedEntries = inventory.entries.filter((e) => selected.has(e.path));
  const extensions = useMemo(() => workbookExtensions(entries), [entries]);
  const duplicates = useMemo(() => workbookDuplicates(visible), [visible]);
  const coverage = useMemo(
    () =>
      topValue.error || topValue.value === null
        ? null
        : workbookCoverage(visible, topValue.value),
    [visible, topValue.value, topValue.error],
  );
  const delta = useMemo(
    () =>
      baseline === null
        ? []
        : workbookDelta(baseline.entries, inventory.entries),
    [baseline, inventory],
  );
  const bytes = visible.reduce((n, e) => n + (e.size === null ? 0 : e.size), 0);
  const unknown = visible.filter((e) => e.size === null).length;
  const viewConditions = { parent: conditions, workbook: filters };
  const toggle = (setter: typeof setSelected, value: string) =>
    setter((old) => {
      const next = new Set(old);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  async function loadBaseline() {
    setBusy(true);
    setBaselineState("比較元の容量を取得中…");
    try {
      const response = await fetch(
        `/api/repo/tree-sizes?${new URLSearchParams({ path, revision: baselineRevision })}`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value = await response.json();
      if (
        value.revision !== baselineRevision ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value.pinned_hash) ||
        !Array.isArray(value.entries) ||
        typeof value.truncated !== "boolean" ||
        !value.entries.every(
          (e: Entry) =>
            typeof e.path === "string" &&
            typeof e.hash === "string" &&
            typeof e.mode === "string" &&
            typeof e.type === "string" &&
            (e.size === null || (Number.isSafeInteger(e.size) && e.size >= 0)),
        )
      )
        throw new Error("比較元の応答形式が不正です。");
      setBaseline(value);
      setBaselineState("比較元を取得しました。");
    } catch (error) {
      setBaselineState(
        `比較元を取得できませんでした: ${error instanceof Error ? error.message : String(error)}。前回の比較元は保持しています。`,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="size-workbook">
      <summary>容量調査ワークシート</summary>
      <div className="size-workbook-body">
        <p>
          上の絞り込み結果をさらに調査します。ここでの条件は下のワークシートに適用されます。選択・確認記録はこの取得結果を開いている間だけ保持します。
        </p>
        <div className="size-workbook-tools">
          <label>
            除外するパス文字列
            <input
              aria-label="容量の除外パス"
              value={exclude}
              onChange={(e) => {
                setExclude(e.target.value);
                setPage(0);
              }}
            />
          </label>
          <label>
            Git mode
            <select
              aria-label="容量のGit mode"
              value={mode === null ? "" : mode}
              onChange={(e) => {
                setMode(e.target.value === "" ? null : e.target.value);
                setPage(0);
              }}
            >
              <option value="">すべて</option>
              {[...new Set(inventory.entries.map((e) => e.mode))]
                .sort()
                .map((m) => (
                  <option key={m}>{m}</option>
                ))}
            </select>
          </label>
          <label>
            完全objectハッシュ
            <input
              aria-label="容量のobjectハッシュ"
              value={hash}
              aria-invalid={invalidHash}
              onChange={(e) => {
                setHash(e.target.value);
                setPage(0);
              }}
            />
          </label>
          <label>
            最大ディレクトリ階層（ルートは0）
            <input
              aria-label="容量の最大階層"
              value={depth}
              aria-invalid={!!depthValue.error}
              onChange={(e) => {
                setDepth(e.target.value);
                setPage(0);
              }}
            />
          </label>
          <label>
            拡張子集計からの対象
            <select
              aria-label="容量集計の拡張子"
              value={extension === null ? "all" : JSON.stringify(extension)}
              onChange={(e) => {
                setExtension(
                  e.target.value === "all" ? null : JSON.parse(e.target.value),
                );
                setPage(0);
              }}
            >
              <option value="all">すべて</option>
              {extensions.map((g) => (
                <option key={g.extension} value={JSON.stringify(g.extension)}>
                  {g.extension === "" ? "拡張子なし" : g.extension} · {g.count}
                  件 · {g.bytes} B · 不明{g.unknown}件
                </option>
              ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={hideReviewed}
              onChange={(e) => {
                setHideReviewed(e.target.checked);
                setPage(0);
              }}
            />
            確認済みを隠す
          </label>
        </div>
        {(depthValue.error || invalidHash) && (
          <p role="alert">
            {depthValue.error}
            {invalidHash &&
              "objectハッシュは40桁または64桁の16進数を指定してください。"}
          </p>
        )}
        <div className="size-workbook-actions">
          <button
            type="button"
            onClick={() =>
              download(
                JSON.stringify(inventory, null, 2) + "\n",
                "gitdash-size-response.json",
                "application/json",
              )
            }
          >
            取得応答をJSON保存
          </button>
          {visible.length > 0 && (
            <CopyButton
              label="容量調査をMarkdownコピー"
              value={workbookMarkdown(path, inventory, visible, viewConditions)}
            />
          )}
          <button
            type="button"
            disabled={selectedEntries.length === 0}
            onClick={() =>
              download(
                treeSizesCsv(selectedEntries),
                "gitdash-size-selection.csv",
                "text/csv;charset=utf-8",
              )
            }
          >
            選択{selectedEntries.length}件をCSV保存
          </button>
          <button
            type="button"
            disabled={selected.size === 0}
            onClick={() => setSelected(new Set())}
          >
            選択を解除
          </button>
          <button
            type="button"
            disabled={reviewed.size === 0}
            onClick={() => setReviewed(new Set())}
          >
            確認記録{reviewed.size}件を解除
          </button>
        </div>
        <div className="size-workbook-tools">
          <label>
            表示対象の容量予算（バイト）
            <input
              aria-label="容量予算"
              value={budget}
              aria-invalid={!!budgetValue.error}
              onChange={(e) => setBudget(e.target.value)}
            />
          </label>
          <label>
            大きい順の上位パス数
            <input
              aria-label="容量の上位件数"
              value={top}
              aria-invalid={!!topValue.error}
              onChange={(e) => setTop(e.target.value)}
            />
          </label>
        </div>
        {budgetValue.error && <p role="alert">予算: {budgetValue.error}</p>}
        {budgetValue.value !== null && !depthValue.error && !invalidHash && (
          <p role="status">
            既知合計 {bytes} B / 予算 {budgetValue.value} B ·{" "}
            {bytes > budgetValue.value
              ? `${bytes - budgetValue.value} B超過`
              : `既知分の残り ${budgetValue.value - bytes} B`}
            {unknown > 0 ? " · サイズ不明があるため予算内かは未確定" : ""}
            {inventory.truncated ? " · 取得結果は部分集計" : ""}
          </p>
        )}
        {topValue.error && <p role="alert">上位件数: {topValue.error}</p>}
        {coverage && (
          <details>
            <summary>
              上位{coverage.largest.length}件で既知容量の
              {coverage.percent === null
                ? "算出不可"
                : coverage.percent.toFixed(1) + "%"}
              （{coverage.bytes} / {coverage.total} B）
            </summary>
            <p>
              表示対象の既知サイズだけの割合です。不明{coverage.unknown}件。
            </p>
            <ol>
              {coverage.largest.map((e) => (
                <li key={e.path}>
                  <code>{e.path}</code> · {formatTreeSizeBytes(e.size)}
                </li>
              ))}
            </ol>
          </details>
        )}
        <div
          className="size-workbook-actions"
          aria-label="容量ワークシートのページ"
        >
          <label>
            1ページ
            <select
              aria-label="容量ワークシートのページ件数"
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(0);
              }}
            >
              {[25, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            前の容量ページ
          </button>
          <span role="status">
            {currentPage + 1} / {totalPages}ページ · {visible.length}件
          </span>
          <button
            type="button"
            disabled={currentPage === totalPages - 1}
            onClick={() => setPage(currentPage + 1)}
          >
            次の容量ページ
          </button>
          <button
            type="button"
            disabled={paged.length === 0}
            onClick={() =>
              setSelected(
                (old) => new Set([...old, ...paged.map((e) => e.path)]),
              )
            }
          >
            このページを選択
          </button>
        </div>
        <div
          className="tree-sizes-table-wrap"
          tabIndex={0}
          role="region"
          aria-label="容量ワークシート一覧"
        >
          <table className="tree-sizes-table">
            <thead>
              <tr>
                <th>選択</th>
                <th>パス</th>
                <th>mode</th>
                <th>容量</th>
                <th>確認</th>
              </tr>
            </thead>
            <tbody>
              {paged.map((e) => (
                <tr key={e.path}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`容量選択 ${e.path}`}
                      checked={selected.has(e.path)}
                      onChange={() => toggle(setSelected, e.path)}
                    />
                  </td>
                  <th>
                    <code>{e.path}</code>
                  </th>
                  <td>{e.mode}</td>
                  <td>{formatTreeSizeBytes(e.size)}</td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`容量確認 ${e.path}`}
                      checked={reviewed.has(e.path)}
                      onChange={() => toggle(setReviewed, e.path)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {visible.length === 0 && (
          <p role="status">ワークシートの条件に一致するパスはありません。</p>
        )}
        <details>
          <summary>重複objectのパス対応（{duplicates.length}組）</summary>
          <p>同じtypeとhashの参照です。削減可能な容量を示しません。</p>
          {duplicates.length > 0 && (
            <CopyButton
              label="重複パス対応をJSONコピー"
              value={JSON.stringify(duplicates, null, 2) + "\n"}
            />
          )}
          {duplicates.map((g) => (
            <div key={`${g[0].type}:${g[0].hash}`}>
              <code>
                {g[0].type} {g[0].hash}
              </code>
              <ul>
                {g.map((e) => (
                  <li key={e.path}>
                    <code>{e.path}</code>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </details>
        <section>
          <h5>別の版からのパス別容量変化</h5>
          <p>
            比較元と今回の取得済み全パスを比較します。上の表示条件は適用しません。改名は削除と追加、不明サイズの差は不明として扱います。
          </p>
          <div className="size-workbook-actions">
            <label>
              比較元revision
              <input
                aria-label="容量の比較元revision"
                value={baselineRevision}
                disabled={busy}
                onChange={(e) => setBaselineRevision(e.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={busy || baselineRevision === ""}
              onClick={() => void loadBaseline()}
            >
              比較元の容量を取得
            </button>
          </div>
          <p role="status">{baselineState}</p>
          {baseline && (
            <>
              <p>
                <code>{baseline.pinned_hash}</code> →{" "}
                <code>{inventory.pinned_hash}</code> · {delta.length}パスに変化
              </p>
              {(baseline.truncated || inventory.truncated) && (
                <p role="status">
                  取得上限による部分比較です。未取得パスが追加・削除と表示される可能性があります。
                </p>
              )}
              <CopyButton
                label="容量の版間比較をJSONコピー"
                value={
                  JSON.stringify(
                    {
                      path,
                      before: baseline,
                      after: inventory,
                      changes: delta,
                    },
                    null,
                    2,
                  ) + "\n"
                }
              />
              <div
                className="tree-sizes-table-wrap"
                tabIndex={0}
                role="region"
                aria-label="容量の版間比較"
              >
                <table className="tree-sizes-table">
                  <thead>
                    <tr>
                      <th>パス</th>
                      <th>変化</th>
                      <th>前</th>
                      <th>後</th>
                      <th>差（B）</th>
                    </tr>
                  </thead>
                  <tbody>
                    {delta.map((d) => (
                      <tr key={d.path}>
                        <th>
                          <code>{d.path}</code>
                        </th>
                        <td>{d.kind}</td>
                        <td>
                          {d.before === null
                            ? "存在なし"
                            : formatTreeSizeBytes(d.before.size)}
                        </td>
                        <td>
                          {d.after === null
                            ? "存在なし"
                            : formatTreeSizeBytes(d.after.size)}
                        </td>
                        <td>{d.delta === null ? "不明" : d.delta}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      </div>
    </details>
  );
}

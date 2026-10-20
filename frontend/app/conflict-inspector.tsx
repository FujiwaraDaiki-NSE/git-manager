"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import PatchView from "./patch-view";
import {
  CONFLICT_STAGE_BASE,
  CONFLICT_STAGE_OURS,
  CONFLICT_STAGE_THEIRS,
  CONFLICT_STAGES,
  buildConflictComparisonQuery,
  buildConflictInventoryQuery,
  buildConflictStageQuery,
  conflictBase64ToBytes,
  conflictComparisonAvailability,
  conflictDownloadName,
  conflictInventoryCsv,
  conflictStageAvailability,
  conflictStageHash,
  conflictStageLabel,
  conflictStageRecord,
  conflictResponseSnapshotKey,
  isConflictInventory,
} from "./conflict-inspector-tools.mjs";
import "./conflict-inspector.css";

type LoadState = "idle" | "loading" | "ready" | "error";

type ConflictStage = {
  stage: number;
  hash: string;
  mode: string;
  type: string;
  kind: string;
  size: number;
};

type ConflictFile = {
  path: string;
  stages: Record<string, ConflictStage>;
  base: ConflictStage | null;
  ours: ConflictStage | null;
  theirs: ConflictStage | null;
  missing_stages: number[];
};

type ConflictInventory = {
  files: ConflictFile[];
  truncated: boolean;
  file_limit: number;
  byte_limit: number;
  snapshot_key: string;
  snapshot: { key: string; files: unknown[]; truncated: boolean };
};

type ConflictStageResponse = {
  input: { file: string; stage: number; expected_hash: string };
  path: string;
  file: string;
  stage: number;
  stage_name: string;
  hash: string;
  mode: string;
  type: string;
  kind: string;
  size: number;
  snapshot: { path: string; stages: Record<string, unknown> };
  download_limit: number;
  content_base64: string;
  text: string | null;
  binary: boolean;
  truncated: boolean;
  complete: boolean;
  downloadable: boolean;
  unavailable_reason: string | null;
};

type ConflictComparisonResponse = {
  input: { file: string; ours_hash: string; theirs_hash: string };
  path: string;
  ours_hash: string;
  theirs_hash: string;
  snapshot: { path: string; stages: Record<string, unknown> };
  patch: string;
  patch_bytes: number;
  patch_limit_bytes: number;
  patch_truncated: boolean;
  patch_complete: boolean;
  binary: boolean;
  unavailable_reason: string | null;
  command: string | null;
};

type ConflictInspectorProps = { path: string };

function responseError(response: Response) {
  return response
    .json()
    .then((body: unknown) => {
      if (body && typeof body === "object" && "detail" in body && typeof body.detail === "string") return body.detail;
      return `HTTP ${response.status}`;
    })
    .catch(() => `HTTP ${response.status}`);
}

function stageSize(value: number | null | undefined) {
  return typeof value === "number" ? `${value.toLocaleString()} bytes` : "サイズ不明";
}

function downloadBlob(bytes: Uint8Array, type: string, name: string) {
  const blob = new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stageLabelWithAvailability(file: ConflictFile, stage: number) {
  const availability = conflictStageAvailability(file, stage);
  return {
    label: conflictStageLabel(stage),
    availability,
    record: conflictStageRecord(file, stage),
  };
}

export default function ConflictInspector({ path }: ConflictInspectorProps) {
  const [open, setOpen] = useState(false);
  const [inventory, setInventory] = useState<ConflictInventory | null>(null);
  const [inventoryState, setInventoryState] = useState<LoadState>("idle");
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState("");
  const [selectedStage, setSelectedStage] = useState(CONFLICT_STAGE_OURS);
  const [stageData, setStageData] = useState<ConflictStageResponse | null>(null);
  const [stageState, setStageState] = useState<LoadState>("idle");
  const [stageError, setStageError] = useState<string | null>(null);
  const [comparison, setComparison] = useState<ConflictComparisonResponse | null>(null);
  const [comparisonState, setComparisonState] = useState<LoadState>("idle");
  const [comparisonError, setComparisonError] = useState<string | null>(null);
  const [downloadStatus, setDownloadStatus] = useState("");
  const [exportStatus, setExportStatus] = useState("");
  const inventoryController = useRef<AbortController | null>(null);
  const stageController = useRef<AbortController | null>(null);
  const comparisonController = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);
  const inventoryRequestKey = useRef<string | null>(null);
  const stageRequestKey = useRef<string | null>(null);
  const comparisonRequestKey = useRef<string | null>(null);

  useEffect(() => {
    inventoryController.current?.abort();
    stageController.current?.abort();
    comparisonController.current?.abort();
    inventoryController.current = null;
    stageController.current = null;
    comparisonController.current = null;
    inventoryRequestKey.current = null;
    stageRequestKey.current = null;
    comparisonRequestKey.current = null;
    setInventory(null);
    setInventoryState("idle");
    setInventoryError(null);
    setSelectedFile("");
    setSelectedStage(CONFLICT_STAGE_OURS);
    setStageData(null);
    setStageState("idle");
    setStageError(null);
    setComparison(null);
    setComparisonState("idle");
    setComparisonError(null);
    setDownloadStatus("");
    setExportStatus("");
    return () => {
      inventoryController.current?.abort();
      stageController.current?.abort();
      comparisonController.current?.abort();
    };
  }, [path]);

  const file = useMemo(
    () => inventory?.files.find((entry) => entry.path === selectedFile) ?? null,
    [inventory, selectedFile],
  );
  const inventorySnapshotKey = conflictResponseSnapshotKey(inventory);

  const loadInventory = () => {
    inventoryController.current?.abort();
    stageController.current?.abort();
    comparisonController.current?.abort();
    const controller = new AbortController();
    const key = `${path}:inventory:${++requestSequence.current}`;
    inventoryController.current = controller;
    inventoryRequestKey.current = key;
    setInventoryState("loading");
    setInventoryError(null);
    setStageData(null);
    setStageState("idle");
    setStageError(null);
    setComparison(null);
    setComparisonState("idle");
    setComparisonError(null);
    setExportStatus("");
    void fetch(`/api/repo/conflicts?${buildConflictInventoryQuery(path)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseError(response));
        return await response.json() as unknown;
      })
      .then((value) => {
        if (controller.signal.aborted || inventoryRequestKey.current !== key) return;
        if (!isConflictInventory(value)) throw new Error("競合一覧の応答形式を確認できません");
        const next = value as ConflictInventory;
        setInventory(next);
        setSelectedFile((current) => next.files.some((entry) => entry.path === current) ? current : (next.files[0]?.path ?? ""));
        setSelectedStage((current) => next.files.some((entry) => {
          const availability = conflictStageAvailability(entry, current);
          return entry.path === (selectedFile || next.files[0]?.path) && availability.available;
        }) ? current : CONFLICT_STAGES.find((stage) => next.files[0] && conflictStageAvailability(next.files[0], stage).available) ?? CONFLICT_STAGE_OURS);
        setInventoryState("ready");
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || inventoryRequestKey.current !== key) return;
        setInventoryError(reason instanceof Error ? reason.message : "競合一覧を取得できませんでした。");
        setInventoryState("error");
      })
      .finally(() => {
        if (inventoryController.current === controller && inventoryRequestKey.current === key) inventoryController.current = null;
      });
  };

  const loadStage = (nextFile: ConflictFile, stage: number) => {
    const hash = conflictStageHash(nextFile, stage);
    const availability = conflictStageAvailability(nextFile, stage);
    if (!hash || !availability.available) return;
    stageController.current?.abort();
    comparisonController.current?.abort();
    const controller = new AbortController();
    const key = `${path}|${nextFile.path}|${stage}|${hash}|${inventorySnapshotKey ?? ""}|${++requestSequence.current}`;
    stageController.current = controller;
    stageRequestKey.current = key;
    setSelectedStage(stage);
    setStageData(null);
    setStageState("loading");
    setStageError(null);
    setDownloadStatus("");
    setComparison(null);
    setComparisonState("idle");
    setComparisonError(null);
    void fetch(`/api/repo/conflict-stage?${buildConflictStageQuery(path, nextFile.path, stage, hash)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseError(response));
        return await response.json() as ConflictStageResponse;
      })
      .then((value) => {
        if (controller.signal.aborted || stageRequestKey.current !== key) return;
        if (value.input?.file !== nextFile.path || value.input?.stage !== stage || value.input?.expected_hash?.toLowerCase() !== hash.toLowerCase()) throw new Error("競合stageの応答が要求と一致しません");
        setStageData(value);
        setStageState("ready");
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || stageRequestKey.current !== key) return;
        setStageError(reason instanceof Error ? reason.message : "競合stageを取得できませんでした。");
        setStageState("error");
      })
      .finally(() => {
        if (stageController.current === controller && stageRequestKey.current === key) stageController.current = null;
      });
  };

  const loadComparison = () => {
    if (file === null) return;
    const availability = conflictComparisonAvailability(file);
    const oursHash = conflictStageHash(file, CONFLICT_STAGE_OURS);
    const theirsHash = conflictStageHash(file, CONFLICT_STAGE_THEIRS);
    if (!availability.available || oursHash === null || theirsHash === null) return;
    comparisonController.current?.abort();
    const controller = new AbortController();
    const key = `${path}|${file.path}|${oursHash}|${theirsHash}|${inventorySnapshotKey ?? ""}|${++requestSequence.current}`;
    comparisonController.current = controller;
    comparisonRequestKey.current = key;
    setComparisonState("loading");
    setComparisonError(null);
    setComparison(null);
    void fetch(`/api/repo/conflict-comparison?${buildConflictComparisonQuery(path, file.path, oursHash, theirsHash)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseError(response));
        return await response.json() as ConflictComparisonResponse;
      })
      .then((value) => {
        if (controller.signal.aborted || comparisonRequestKey.current !== key) return;
        if (value.input?.file !== file.path || value.input?.ours_hash?.toLowerCase() !== oursHash.toLowerCase() || value.input?.theirs_hash?.toLowerCase() !== theirsHash.toLowerCase()) throw new Error("OURS/THEIRS比較の応答が要求と一致しません");
        setComparison(value);
        setComparisonState("ready");
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || comparisonRequestKey.current !== key) return;
        setComparisonError(reason instanceof Error ? reason.message : "OURS/THEIRS比較を取得できませんでした。");
        setComparisonState("error");
      })
      .finally(() => {
        if (comparisonController.current === controller && comparisonRequestKey.current === key) comparisonController.current = null;
      });
  };

  const changeFile = (nextPath: string) => {
    stageController.current?.abort();
    comparisonController.current?.abort();
    setSelectedFile(nextPath);
    const nextFile = inventory?.files.find((entry) => entry.path === nextPath) ?? null;
    const firstAvailable = nextFile === null ? CONFLICT_STAGE_OURS : CONFLICT_STAGES.find((stage) => conflictStageAvailability(nextFile, stage).available) ?? CONFLICT_STAGE_OURS;
    setSelectedStage(firstAvailable);
    setStageData(null);
    setStageState("idle");
    setStageError(null);
    setComparison(null);
    setComparisonState("idle");
    setComparisonError(null);
    setDownloadStatus("");
  };

  const downloadStage = () => {
    if (stageData === null || !stageData.downloadable || stageData.content_base64 === "") return;
    try {
      const bytes = conflictBase64ToBytes(stageData.content_base64);
      downloadBlob(bytes, stageData.binary ? "application/octet-stream" : "text/plain;charset=utf-8", conflictDownloadName(stageData.path, stageData.stage, stageData.binary ? "bin" : "txt"));
      setDownloadStatus("完全なblobを保存しました。");
    } catch (reason: unknown) {
      setDownloadStatus(reason instanceof Error ? reason.message : "blobを保存できませんでした。");
    }
  };

  const exportInventory = () => {
    if (inventory === null) return;
    try {
      const blob = new Blob([conflictInventoryCsv(inventory.files)], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "gitdash-conflicts.csv";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportStatus("CSVを保存しました。");
    } catch (reason: unknown) {
      setExportStatus(reason instanceof Error ? reason.message : "CSVを保存できませんでした。");
    }
  };

  const selectedStageIsCurrent = stageData !== null && file !== null && stageData.input.file === file.path && stageData.input.stage === selectedStage && stageData.input.expected_hash.toLowerCase() === (conflictStageHash(file, selectedStage) ?? "").toLowerCase();
  const comparisonIsCurrent = comparison !== null && file !== null && comparison.input.file === file.path && comparison.input.ours_hash.toLowerCase() === (conflictStageHash(file, CONFLICT_STAGE_OURS) ?? "").toLowerCase() && comparison.input.theirs_hash.toLowerCase() === (conflictStageHash(file, CONFLICT_STAGE_THEIRS) ?? "").toLowerCase();
  const comparisonAvailability = file === null ? { available: false, reason: "競合ファイルを選択してください。" } : conflictComparisonAvailability(file);

  return (
    <details className="conflict-inspector" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>競合ファイルの内容を調べる <span>INDEXのBASE / OURS / THEIRS</span></summary>
      <div className="conflict-inspector-body">
        <div className="conflict-inspector-heading">
          <div>
            <h3>未解決の競合を読む</h3>
            <p>現在のGit INDEXから競合stageを読み取り、作業ツリーを書き換えずに内容と比較を確認します。</p>
          </div>
          <code className="conflict-inspector-repo" title={path}>{path}</code>
        </div>

        <section className="conflict-inspector-section" aria-labelledby="conflict-inventory-title" aria-busy={inventoryState === "loading"}>
          <div className="conflict-inspector-section-heading">
            <div>
              <h4 id="conflict-inventory-title">競合ファイル一覧</h4>
              <p>一覧の取得は明示操作です。最大{inventory?.file_limit ?? 1000}件・{Math.round((inventory?.byte_limit ?? 4 * 1024 * 1024) / (1024 * 1024))}MiBまでです。</p>
            </div>
            <div className="conflict-inspector-actions">
              <button type="button" className="primary-action" disabled={inventoryState === "loading"} onClick={loadInventory}>{inventoryState === "loading" ? "一覧を取得中…" : inventoryState === "idle" ? "競合一覧を取得" : "競合一覧を再取得"}</button>
              {inventory && <button type="button" className="subtle-button" onClick={exportInventory}>一覧をCSV保存</button>}
            </div>
          </div>
          {inventoryState === "error" && <p className="conflict-inspector-error" role="alert">競合一覧を取得できませんでした。{inventoryError && <span>（{inventoryError}）</span>}</p>}
          {exportStatus && <p className="conflict-inspector-status" role="status" aria-live="polite">{exportStatus}</p>}
          {inventory && (
            <>
              <div className="conflict-inspector-inventory-summary" role="status">
                <span>{inventory.files.length.toLocaleString()} 件</span>
                {inventory.truncated && <span className="conflict-inspector-warning">上限に達したため一覧は一部です。</span>}
              </div>
              {inventory.files.length === 0 ? <p className="conflict-inspector-empty">INDEXに未解決の競合はありません。</p> : <>
                <label className="conflict-inspector-file-select"><span>調べる競合ファイル</span><select value={selectedFile} onChange={(event) => changeFile(event.target.value)} aria-label="調べる競合ファイル"><option value="" disabled>ファイルを選択</option>{inventory.files.map((entry) => <option value={entry.path} key={entry.path}>{entry.path}</option>)}</select></label>
                <div className="conflict-inspector-table-wrap">
                  <table className="conflict-inspector-table">
                    <thead><tr><th scope="col">パス</th><th scope="col">BASE</th><th scope="col">OURS</th><th scope="col">THEIRS</th></tr></thead>
                    <tbody>{inventory.files.map((entry) => <tr key={entry.path} className={entry.path === selectedFile ? "is-selected" : undefined}>
                      <th scope="row"><button type="button" className="conflict-inspector-path-button" onClick={() => changeFile(entry.path)}>{entry.path}</button></th>
                      {CONFLICT_STAGES.map((stage) => {
                        const status = stageLabelWithAvailability(entry, stage);
                        return <td key={stage} title={status.availability.reason ?? undefined}><span className={`conflict-inspector-stage-cell${status.availability.available ? " is-available" : " is-unavailable"}`}>{status.record ? `${stageSize(status.record.size)}` : "なし"}</span></td>;
                      })}
                    </tr>)}</tbody>
                  </table>
                </div>
              </>}
            </>
          )}
        </section>

        {file && <>
          <section className="conflict-inspector-section" aria-labelledby="conflict-stage-title" aria-busy={stageState === "loading"}>
            <div className="conflict-inspector-section-heading"><div><h4 id="conflict-stage-title">stage内容</h4><p><code>{file.path}</code> のINDEX stageを選ぶと、対応するblobだけを読み取ります。</p></div></div>
            <div className="conflict-inspector-stage-tabs" role="group" aria-label="競合stageを選択">
              {CONFLICT_STAGES.map((stage) => {
                const status = stageLabelWithAvailability(file, stage);
                const record = status.record;
                return <button type="button" key={stage} className={`conflict-inspector-stage-tab${selectedStage === stage ? " is-selected" : ""}`} disabled={!status.availability.available || stageState === "loading"} aria-pressed={selectedStage === stage} title={status.availability.reason ?? undefined} onClick={() => loadStage(file, stage)}><strong>{status.label}</strong><span>{record ? stageSize(record.size) : (status.availability.reason ?? "利用不可")}</span></button>;
              })}
            </div>
            {stageState === "error" && <p className="conflict-inspector-error" role="alert">stageを取得できませんでした。{stageError && <span>（{stageError}）</span>}</p>}
            {stageData && selectedStageIsCurrent && <div className="conflict-inspector-preview">
              <div className="conflict-inspector-preview-heading"><div><strong>{conflictStageLabel(stageData.stage)} / {stageData.kind}</strong><span>{stageData.mode}・{stageSize(stageData.size)}・{stageData.hash}</span></div><button type="button" className="subtle-button" disabled={!stageData.downloadable} title={stageData.downloadable ? "INDEXで検証した完全なblobを保存" : "1MiB以下で完全に読み取れた通常blobだけ保存できます"} onClick={downloadStage}>完全なblobを保存</button></div>
              {stageData.unavailable_reason && <p className="conflict-inspector-unavailable" role="status">{stageData.unavailable_reason}</p>}
              {stageData.text !== null && <pre className="conflict-inspector-text">{stageData.text}</pre>}
              {stageData.text === null && stageData.binary && stageData.complete && <p className="conflict-inspector-binary" role="status">バイナリblobです。内容は完全なblobのダウンロードで確認できます。</p>}
              {stageData.truncated && <p className="conflict-inspector-warning" role="status">blobが{stageData.download_limit.toLocaleString()} bytesを超えるため、プレビューは先頭部分だけです。完全なダウンロードは無効です。</p>}
              {downloadStatus && <p className="conflict-inspector-status" role="status" aria-live="polite">{downloadStatus}</p>}
            </div>}
          </section>

          <section className="conflict-inspector-section" aria-labelledby="conflict-comparison-title" aria-busy={comparisonState === "loading"}>
            <div className="conflict-inspector-section-heading"><div><h4 id="conflict-comparison-title">OURS / THEIRS 比較</h4><p>現在のINDEXで検証したOURSとTHEIRSをGitの読み取り専用diffで比較します。</p></div><button type="button" className="primary-action" disabled={!comparisonAvailability.available || comparisonState === "loading"} title={comparisonAvailability.reason ?? undefined} onClick={loadComparison}>{comparisonState === "loading" ? "比較を取得中…" : comparisonState === "idle" ? "OURS / THEIRSを比較" : "比較を再取得"}</button></div>
            {!comparisonAvailability.available && <p className="conflict-inspector-unavailable" role="status">{comparisonAvailability.reason}</p>}
            {comparisonState === "error" && <p className="conflict-inspector-error" role="alert">比較を取得できませんでした。{comparisonError && <span>（{comparisonError}）</span>}</p>}
            {comparison && comparisonIsCurrent && <div className="conflict-inspector-comparison">
              {comparison.unavailable_reason && <p className="conflict-inspector-unavailable" role="status">{comparison.unavailable_reason}</p>}
              {comparison.binary && <p className="conflict-inspector-binary" role="status">Gitがバイナリ差分として判定しました。テキスト行はありません。</p>}
              {comparison.patch_complete && comparison.patch === "" && !comparison.binary && <p className="conflict-inspector-empty">OURSとTHEIRSにテキスト差分はありません。</p>}
              <PatchView patch={comparison.patch} />
              {comparison.patch_truncated && <p className="conflict-inspector-warning" role="status">パッチ本文は{comparison.patch_limit_bytes.toLocaleString()} bytesで切り詰められています。比較結果は部分表示です。</p>}
            </div>}
          </section>
        </>}
      </div>
    </details>
  );
}

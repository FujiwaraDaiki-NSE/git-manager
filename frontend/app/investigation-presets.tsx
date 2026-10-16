"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import CopyButton from "./copy-button";
import {
  addInvestigationPreset,
  buildInvestigationShareUrl,
  deleteInvestigationPreset,
  mergeInvestigationStores,
  parseInvestigationBackup,
  parseInvestigationUrl,
  readInvestigationStore,
  renameInvestigationPreset,
  serializeInvestigationBackup,
  validateInvestigationValues,
  writeInvestigationStore,
  investigationStorageKey,
} from "./investigation-presets-tools.mjs";
import "./investigation-presets.css";

export type ComparisonPresetValues = {
  base: string;
  target: string;
  mode: "direct" | "merge-base";
};

export type FileHistoryPresetValues = {
  revision: string;
  file: string;
  follow: boolean;
};

export type InvestigationKind = "compare" | "file-history";
export type InvestigationValues = ComparisonPresetValues | FileHistoryPresetValues;

type InvestigationPreset = {
  id: string;
  name: string;
  kind: InvestigationKind;
  values: InvestigationValues;
  createdAt: number;
  updatedAt: number;
};

type InvestigationStore = {
  version: number;
  presets: InvestigationPreset[];
};

type InvestigationPresetsProps = {
  kind: InvestigationKind;
  repoPath: string;
  values: InvestigationValues;
  onApply: (values: InvestigationValues) => void;
};

const STORE_EVENT = "gitdash:investigation-presets";

function kindLabel(kind: InvestigationKind) {
  return kind === "compare" ? "比較" : "ファイル履歴";
}

function valuesForKind(kind: InvestigationKind, values: InvestigationValues) {
  const result = validateInvestigationValues(kind, values);
  return result.ok ? result.values : null;
}

function storageForBrowser() {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function emitStoreEvent(repoPath: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(STORE_EVENT, { detail: { repoPath } }));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "保存条件を処理できませんでした";
}

export default function InvestigationPresets({ kind, repoPath, values, onApply }: InvestigationPresetsProps) {
  const onApplyRef = useRef(onApply);
  const [store, setStore] = useState<InvestigationStore>({ version: 1, presets: [] });
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("");
  const [importMode, setImportMode] = useState<"reject" | "dedupe">("reject");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [storageRaw, setStorageRaw] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  const scopedPresets = useMemo(
    () => store.presets.filter((preset) => preset.kind === kind),
    [kind, store.presets],
  );
  const selected = scopedPresets.find((preset) => preset.id === selectedId) ?? null;
  const currentValues = valuesForKind(kind, values);
  const shareUrl = useMemo(() => {
    if (!mounted || !currentValues || typeof window === "undefined") return "";
    try {
      return buildInvestigationShareUrl(window.location.href, kind, currentValues);
    } catch {
      return "";
    }
  }, [currentValues, kind, mounted]);

  const reload = () => {
    const result = readInvestigationStore(storageForBrowser(), repoPath);
    setStore(result.store as InvestigationStore);
    setStorageRaw(result.raw);
    setError(result.error);
    setStatus("");
    setSelectedId((current) => result.store.presets.some((preset) => preset.id === current && preset.kind === kind) ? current : "");
  };

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    onApplyRef.current = onApply;
  }, [onApply]);

  useEffect(() => {
    reload();
    const handleStoreEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ repoPath?: unknown }>).detail;
      if (detail?.repoPath === repoPath) reload();
    };
    window.addEventListener(STORE_EVENT, handleStoreEvent);
    const handleStorageEvent = (event: StorageEvent) => {
      if ((event.storageArea === null || event.storageArea === storageForBrowser()) && (event.key === null || event.key === investigationStorageKey(repoPath))) reload();
    };
    window.addEventListener("storage", handleStorageEvent);
    return () => {
      window.removeEventListener(STORE_EVENT, handleStoreEvent);
      window.removeEventListener("storage", handleStorageEvent);
    };
  }, [kind, repoPath]);

  useEffect(() => {
    const parseUrl = () => {
      const parsed = parseInvestigationUrl(window.location.search);
      setUrlError(parsed.owner === kind ? parsed.error : null);
      if (parsed.error || parsed.kind !== kind || parsed.values === null) return;
      onApplyRef.current(parsed.values as InvestigationValues);
      setStatus("共有URLの条件を入力欄に反映しました。実行はまだ行っていません。");
    };
    // The parent tool clears its inputs when the repository path changes.  A
    // macrotask lets that reset settle before a valid shared URL is applied,
    // regardless of React's parent/child passive-effect traversal order.
    const timer = window.setTimeout(parseUrl, 0);
    const handlePopState = () => parseUrl();
    window.addEventListener("popstate", handlePopState);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("popstate", handlePopState);
    };
  }, [kind, repoPath]);

  const persist = (next: InvestigationStore, success: string) => {
    const result = writeInvestigationStore(storageForBrowser(), repoPath, next, storageRaw);
    if (!result.ok || result.store === null) {
      // A second tab may have committed while an import file was being read.
      // Refresh the list for the next explicit retry while leaving the form
      // values untouched.
      const fresh = readInvestigationStore(storageForBrowser(), repoPath);
      setStore(fresh.store as InvestigationStore);
      setStorageRaw(fresh.raw);
      setError(result.error || fresh.error);
      setStatus("");
      return false;
    }
    setStore(result.store as InvestigationStore);
    setStorageRaw(result.raw);
    setError(null);
    setStatus(success);
    emitStoreEvent(repoPath);
    return true;
  };

  const save = () => {
    setError(null);
    setStatus("");
    try {
      const next = addInvestigationPreset(store, kind, values, name);
      const created = next.presets.at(-1);
      if (!persist(next as InvestigationStore, `「${created?.name ?? name.trim()}」を保存しました。`)) return;
      if (created) setSelectedId(created.id);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const rename = () => {
    if (!selected) return;
    setError(null);
    setStatus("");
    try {
      const next = renameInvestigationPreset(store, selected.id, name);
      if (!persist(next as InvestigationStore, `「${name.trim()}」に名前を変更しました。`)) return;
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const remove = () => {
    if (!selected) return;
    if (typeof window !== "undefined" && !window.confirm(`保存条件「${selected.name}」を削除しますか？`)) return;
    setError(null);
    setStatus("");
    try {
      const next = deleteInvestigationPreset(store, selected.id);
      if (!persist(next as InvestigationStore, `「${selected.name}」を削除しました。`)) return;
      setSelectedId("");
      setName("");
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const applySelected = () => {
    if (!selected) return;
    onApply(selected.values);
    setStatus(`「${selected.name}」を入力欄に反映しました。実行はまだ行っていません。`);
    setError(null);
  };

  const exportBackup = () => {
    setError(null);
    setStatus("");
    try {
      const content = serializeInvestigationBackup(store);
      const blob = new Blob([content], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "gitdash-investigation-presets.json";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus("JSONバックアップの保存を開始しました。");
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const importBackup = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setError(null);
    setStatus("");
    try {
      if (file.size > 200_000) throw new RangeError("バックアップが上限を超えています");
      const imported = parseInvestigationBackup(await file.text());
      const merged = mergeInvestigationStores(store, imported, importMode);
      const added = merged.added;
      const skipped = merged.skipped;
      if (!persist(merged.store as InvestigationStore, `JSONバックアップを読み込みました（追加 ${added} 件${skipped ? `・重複除去 ${skipped} 件` : ""}）。`)) return;
      setSelectedId("");
      setName("");
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const selectedKind = selected?.kind === kind;
  const valueError = currentValues ? null : "共有・保存するには必須入力をすべて指定してください。";

  return (
    <section className={`investigation-presets investigation-presets-${kind}`} aria-label={`${kindLabel(kind)}の保存条件と共有`}>
      <div className="investigation-presets-heading">
        <div>
          <h4>{kindLabel(kind)}の保存条件・共有</h4>
          <p>入力値だけをリポジトリごとに保存します。結果データや認証情報は保存しません。</p>
        </div>
      </div>
      {urlError && <p className="investigation-presets-error" role="alert">共有URLを読み込めませんでした。{urlError}</p>}
      {error && <p className="investigation-presets-error" role="alert">{error}</p>}
      {status && <p className="investigation-presets-status" role="status" aria-live="polite">{status}</p>}

      <div className="investigation-presets-save" role="group" aria-label={`${kindLabel(kind)}の保存条件を保存・名前変更`}>
        <label>
          <span>保存名</span>
          <input type="text" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder={`${kindLabel(kind)}の条件名`} />
        </label>
        <button type="button" onClick={save} disabled={name.trim().length === 0}>この入力を保存</button>
        <button type="button" onClick={rename} disabled={!selectedKind || name.trim().length === 0}>名前を変更</button>
      </div>

      <div className="investigation-presets-open" role="group" aria-label={`${kindLabel(kind)}の保存条件を開く`}>
        <label>
          <span>保存済みの{kindLabel(kind)}条件</span>
          <select value={selectedId} onChange={(event) => {
            const nextId = event.target.value;
            setSelectedId(nextId);
            const next = scopedPresets.find((preset) => preset.id === nextId);
            setName(next?.name ?? "");
          }}>
            <option value="">保存条件を選択</option>
            {scopedPresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
          </select>
        </label>
        <button type="button" onClick={applySelected} disabled={!selectedKind}>開く</button>
        <button type="button" onClick={remove} disabled={!selectedKind}>削除</button>
      </div>

      <div className="investigation-presets-backup" role="group" aria-label={`${kindLabel(kind)}のJSONバックアップ`}>
        <button type="button" onClick={exportBackup}>JSONバックアップを保存</button>
        <label>
          <span>JSONバックアップを読み込む</span>
          <input type="file" accept="application/json,.json" onChange={(event) => void importBackup(event)} />
        </label>
        <label>
          <span>重複時の扱い</span>
          <select value={importMode} onChange={(event) => setImportMode(event.target.value as "reject" | "dedupe")}>
            <option value="reject">重複は拒否</option>
            <option value="dedupe">完全一致だけ重複除去</option>
          </select>
        </label>
      </div>

      <div className="investigation-presets-share" role="group" aria-label={`${kindLabel(kind)}の共有URL`}>
        <div>
          <span>共有URL</span>
          <small>開いた画面に入力値を反映します。自動実行はしません。</small>
        </div>
        {shareUrl ? <CopyButton value={shareUrl} label={`${kindLabel(kind)}の共有URLをコピー`} /> : <span className="investigation-presets-unavailable">{valueError}</span>}
      </div>
    </section>
  );
}

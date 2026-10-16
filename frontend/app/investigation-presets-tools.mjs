// @ts-check

/**
 * Shared, deliberately small data contract for the compare and file-history
 * investigation helpers.  The UI keeps result data out of this store: only
 * the complete input values needed to reproduce an investigation are saved.
 */

export const INVESTIGATION_KINDS = ["compare", "file-history"];
export const COMPARISON_INVESTIGATION_MODES = ["direct", "merge-base"];
export const INVESTIGATION_STORE_VERSION = 1;
export const INVESTIGATION_MAX_PRESETS = 50;
export const INVESTIGATION_MAX_NAME_LENGTH = 80;
export const INVESTIGATION_MAX_VALUE_LENGTH = 512;
export const INVESTIGATION_MAX_BACKUP_BYTES = 200_000;
export const INVESTIGATION_STORAGE_PREFIX = "gitdash.investigation-presets.v1:";

export const INVESTIGATION_QUERY_KEYS = [
  "investigation",
  "investigationBase",
  "investigationTarget",
  "investigationMode",
  "investigationRevision",
  "investigationFile",
  "investigationFollow",
];

const KIND_SET = new Set(INVESTIGATION_KINDS);
const MODE_SET = new Set(COMPARISON_INVESTIGATION_MODES);
const QUERY_KEY_SET = new Set(INVESTIGATION_QUERY_KEYS);

/** @typedef {{[key: string]: any}} LooseRecord */
/** @typedef {{base: string, target: string, mode: string} | {revision: string, file: string, follow: boolean}} InvestigationValues */
/** @typedef {{id: string, name: string, kind: string, values: InvestigationValues, createdAt: number, updatedAt: number}} InvestigationPreset */
/** @typedef {{version: number, presets: InvestigationPreset[]}} InvestigationStore */

/** @param {unknown} value @returns {value is LooseRecord} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {number} [limit] @returns {value is string} */
function isBoundedString(value, limit = INVESTIGATION_MAX_VALUE_LENGTH) {
  return typeof value === "string" && value.length <= limit;
}

/** @param {string} value @param {string} field */
function normalizedRequiredString(value, field) {
  if (!isBoundedString(value)) throw new TypeError(`${field} must be a string of at most ${INVESTIGATION_MAX_VALUE_LENGTH} characters`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${field} must be provided explicitly`);
  return normalized;
}

/** Keep repository-relative filenames byte-for-byte; spaces can be part of a Git path. */
/** @param {unknown} value */
function normalizedFileString(value) {
  if (!isBoundedString(value)) throw new TypeError(`file must be a string of at most ${INVESTIGATION_MAX_VALUE_LENGTH} characters`);
  if (value.trim().length === 0) throw new TypeError("file must be provided explicitly");
  return value;
}

/** @param {unknown} value */
function normalizedName(value) {
  if (!isBoundedString(value, INVESTIGATION_MAX_NAME_LENGTH)) {
    throw new TypeError(`name must be a string of at most ${INVESTIGATION_MAX_NAME_LENGTH} characters`);
  }
  const name = value.trim();
  if (name.length === 0) throw new TypeError("name must be provided explicitly");
  return name;
}

/** @param {unknown} value */
function normalizedMode(value) {
  if (typeof value !== "string" || !MODE_SET.has(value)) throw new TypeError(`Unknown comparison mode: ${String(value)}`);
  return value;
}

/**
 * Validate and normalize one complete investigation input.  The caller must
 * provide every field, including the history boolean; omitted fields are
 * rejected instead of being guessed.
 *
 * @param {string} kind
 * @param {unknown} values
 * @returns {InvestigationValues}
 */
export function normalizeInvestigationValues(kind, values) {
  if (!KIND_SET.has(kind) || !isRecord(values)) throw new TypeError("Investigation kind and values must be explicit");
  const record = values;
  if (kind === "compare") {
    if (!("base" in values) || !("target" in values) || !("mode" in values)) {
      throw new TypeError("Compare values must include base, target, and mode");
    }
    return {
      base: normalizedRequiredString(record.base, "base"),
      target: normalizedRequiredString(record.target, "target"),
      mode: normalizedMode(record.mode),
    };
  }
  if (!("revision" in values) || !("file" in values) || !("follow" in values)) {
    throw new TypeError("File-history values must include revision, file, and follow");
  }
  if (typeof record.follow !== "boolean") throw new TypeError("follow must be a boolean");
  return {
    revision: normalizedRequiredString(record.revision, "revision"),
    file: normalizedFileString(record.file),
    follow: record.follow,
  };
}

/** @param {string} kind @param {unknown} values */
export function validateInvestigationValues(kind, values) {
  try {
    return { ok: true, values: normalizeInvestigationValues(kind, values), error: null };
  } catch (error) {
    return { ok: false, values: null, error: error instanceof Error ? error.message : "Investigation values are invalid" };
  }
}

/** @param {string} kind @param {unknown} values @param {string} name @param {number} [now] @param {string|null} [id] */
export function createInvestigationPreset(kind, values, name, now = Date.now(), id = null) {
  if (!Number.isFinite(now) || now < 0) throw new TypeError("now must be a non-negative number");
  const normalized = normalizeInvestigationValues(kind, values);
  const presetId = id === null ? createPresetId() : normalizedRequiredString(id, "id");
  return /** @type {InvestigationPreset} */ ({
    id: presetId,
    name: normalizedName(name),
    kind,
    values: normalized,
    createdAt: now,
    updatedAt: now,
  });
}

function createPresetId() {
  // Browser crypto is preferred, but the generated id is an internal key and
  // never carries user input.  The timestamp branch keeps the helper usable
  // in the Node unit tests and in older browsers.
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** @returns {InvestigationStore} */
export function emptyInvestigationStore() {
  return { version: INVESTIGATION_STORE_VERSION, presets: [] };
}

/** @param {unknown} value @param {string} field */
function validateTimestamp(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`${field} must be a timestamp`);
  return value;
}

/** @param {unknown} value @returns {InvestigationPreset} */
function normalizePreset(value) {
  if (!isRecord(value)) throw new TypeError("Preset must be an object");
  for (const field of /** @type {string[]} */ (["id", "name", "kind", "values", "createdAt", "updatedAt"])) {
    if (!(field in value)) throw new TypeError(`Preset must include ${field}`);
  }
  const id = normalizedRequiredString(value.id, "id");
  const name = normalizedName(value.name);
  if (typeof value.kind !== "string" || !KIND_SET.has(value.kind)) throw new TypeError("Preset kind is invalid");
  return /** @type {InvestigationPreset} */ ({
    id,
    name,
    kind: value.kind,
    values: normalizeInvestigationValues(value.kind, value.values),
    createdAt: validateTimestamp(value.createdAt, "createdAt"),
    updatedAt: validateTimestamp(value.updatedAt, "updatedAt"),
  });
}

/** @param {unknown} value @returns {InvestigationStore} */
export function normalizeInvestigationStore(value) {
  if (!isRecord(value) || value.version !== INVESTIGATION_STORE_VERSION || !Array.isArray(value.presets)) {
    throw new TypeError(`Backup must have version ${INVESTIGATION_STORE_VERSION} and a presets array`);
  }
  if (value.presets.length > INVESTIGATION_MAX_PRESETS) throw new RangeError(`At most ${INVESTIGATION_MAX_PRESETS} presets are supported`);
  const presets = value.presets.map(normalizePreset);
  const ids = new Set();
  const names = new Set();
  for (const preset of presets) {
    if (ids.has(preset.id)) throw new TypeError("Preset ids must be unique");
    const nameKey = `${preset.kind}\u0000${preset.name}`;
    if (names.has(nameKey)) throw new TypeError("Preset names must be unique within an investigation type");
    ids.add(preset.id);
    names.add(nameKey);
  }
  return { version: INVESTIGATION_STORE_VERSION, presets };
}

/** @param {string} repositoryPath */
export function investigationStorageKey(repositoryPath) {
  if (typeof repositoryPath !== "string" || repositoryPath.length === 0) throw new TypeError("repositoryPath is required");
  return `${INVESTIGATION_STORAGE_PREFIX}${encodeURIComponent(repositoryPath)}`;
}

/** @param {Storage | null | undefined} storage @param {string} repositoryPath */
export function readInvestigationStore(storage, repositoryPath) {
  try {
    if (!storage) return { store: emptyInvestigationStore(), error: null, raw: null };
    const raw = storage.getItem(investigationStorageKey(repositoryPath));
    if (raw === null) return { store: emptyInvestigationStore(), error: null, raw: null };
    if (raw.length > INVESTIGATION_MAX_BACKUP_BYTES) throw new RangeError("保存データが上限を超えています");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new TypeError("保存データのJSONを読み込めません");
    }
    return { store: normalizeInvestigationStore(parsed), error: null, raw };
  } catch (error) {
    let raw = null;
    try { raw = storage?.getItem(investigationStorageKey(repositoryPath)) ?? null; } catch { /* keep raw unavailable */ }
    return { store: emptyInvestigationStore(), error: error instanceof Error ? error.message : "保存データを読み込めません", raw };
  }
}

/** @param {Storage | null | undefined} storage @param {string} repositoryPath @param {unknown} store @param {string|null|undefined} [expectedRaw] */
export function writeInvestigationStore(storage, repositoryPath, store, expectedRaw = undefined) {
  try {
    if (!storage) throw new Error("この環境ではローカル保存を利用できません");
    const key = investigationStorageKey(repositoryPath);
    const existingRaw = storage.getItem(key);
    if (expectedRaw !== undefined && existingRaw !== expectedRaw) {
      throw new Error("別の画面で保存条件が更新されたため保存できません。保存済み条件を再読み込みしてから再試行してください");
    }
    if (existingRaw !== null) {
      if (existingRaw.length > INVESTIGATION_MAX_BACKUP_BYTES) throw new RangeError("既存の保存データが上限を超えています");
      let existingParsed;
      try {
        existingParsed = JSON.parse(existingRaw);
      } catch {
        throw new TypeError("既存の保存データが壊れているため上書きできません");
      }
      normalizeInvestigationStore(existingParsed);
    }
    const normalized = normalizeInvestigationStore(store);
    const serialized = JSON.stringify(normalized);
    if (serialized.length > INVESTIGATION_MAX_BACKUP_BYTES) throw new RangeError("保存データが上限を超えています");
    storage.setItem(key, serialized);
    return { ok: true, store: normalized, raw: serialized, error: null };
  } catch (error) {
    return { ok: false, store: null, raw: null, error: error instanceof Error ? error.message : "保存できません" };
  }
}

/** @param {unknown} store @param {string} kind @param {unknown} values @param {string} name @param {number} now */
export function addInvestigationPreset(store, kind, values, name, now = Date.now()) {
  const current = normalizeInvestigationStore(store);
  if (current.presets.length >= INVESTIGATION_MAX_PRESETS) throw new RangeError(`保存できる条件は${INVESTIGATION_MAX_PRESETS}件までです`);
  const preset = createInvestigationPreset(kind, values, name, now);
  if (current.presets.some((item) => item.kind === kind && item.name === preset.name)) {
    throw new Error("同じ種類には同じ名前を保存できません。名前変更または別名を指定してください");
  }
  return { version: INVESTIGATION_STORE_VERSION, presets: [...current.presets, preset] };
}

/** @param {unknown} store @param {string} id @param {string} name @param {number} now */
export function renameInvestigationPreset(store, id, name, now = Date.now()) {
  const current = normalizeInvestigationStore(store);
  const normalizedNameValue = normalizedName(name);
  const index = current.presets.findIndex((item) => item.id === id);
  if (index < 0) throw new Error("名前変更する保存条件が見つかりません");
  const existing = current.presets[index];
  if (current.presets.some((item) => item.id !== id && item.kind === existing.kind && item.name === normalizedNameValue)) {
    throw new Error("同じ種類には同じ名前を保存できません");
  }
  const presets = current.presets.slice();
  presets[index] = { ...existing, name: normalizedNameValue, updatedAt: validateTimestamp(now, "now") };
  return { version: INVESTIGATION_STORE_VERSION, presets };
}

/** @param {unknown} store @param {string} id */
export function deleteInvestigationPreset(store, id) {
  const current = normalizeInvestigationStore(store);
  if (!current.presets.some((item) => item.id === id)) throw new Error("削除する保存条件が見つかりません");
  return { version: INVESTIGATION_STORE_VERSION, presets: current.presets.filter((item) => item.id !== id) };
}

/** @param {unknown} values @param {unknown} other */
function valuesEqual(values, other) {
  return JSON.stringify(values) === JSON.stringify(other);
}

/** @param {unknown} store */
export function serializeInvestigationBackup(store) {
  const normalized = normalizeInvestigationStore(store);
  const serialized = JSON.stringify(normalized, null, 2);
  if (serialized.length > INVESTIGATION_MAX_BACKUP_BYTES) throw new RangeError("バックアップが上限を超えています");
  return serialized;
}

/** @param {string} text */
export function parseInvestigationBackup(text) {
  if (typeof text !== "string" || text.length > INVESTIGATION_MAX_BACKUP_BYTES) throw new RangeError("バックアップが上限を超えています");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TypeError("バックアップのJSONを読み込めません");
  }
  return normalizeInvestigationStore(parsed);
}

/**
 * Merge a validated backup without overwriting existing entries.  In
 * `reject` mode every name/id conflict aborts the operation.  In `dedupe`
 * mode exact value matches are skipped; a same-name different-value conflict
 * still aborts so the user never loses or silently replaces a condition.
 *
 * @param {unknown} currentStore @param {unknown} importedStore @param {"reject"|"dedupe"} conflictMode
 */
export function mergeInvestigationStores(currentStore, importedStore, conflictMode = "reject") {
  const current = normalizeInvestigationStore(currentStore);
  const incoming = normalizeInvestigationStore(importedStore);
  if (conflictMode !== "reject" && conflictMode !== "dedupe") throw new TypeError("Unknown backup conflict mode");
  const result = current.presets.slice();
  const ids = new Set(result.map((item) => item.id));
  const names = new Map(result.map((item) => [`${item.kind}\u0000${item.name}`, item]));
  let skipped = 0;
  for (const preset of incoming.presets) {
    const existingById = result.find((item) => item.id === preset.id);
    const nameKey = `${preset.kind}\u0000${preset.name}`;
    const existingByName = names.get(nameKey);
    if (existingById || existingByName) {
      const exact = existingById && existingById.kind === preset.kind && existingById.name === preset.name && valuesEqual(existingById.values, preset.values);
      const exactName = existingByName && valuesEqual(existingByName.values, preset.values);
      if (conflictMode === "dedupe" && (exact || exactName)) {
        skipped += 1;
        continue;
      }
      throw new Error(`既存の保存条件と衝突しています: ${preset.name}`);
    }
    if (result.length >= INVESTIGATION_MAX_PRESETS) throw new RangeError(`保存できる条件は${INVESTIGATION_MAX_PRESETS}件までです`);
    if (ids.has(preset.id)) throw new Error(`既存の保存条件IDと衝突しています: ${preset.name}`);
    result.push(preset);
    ids.add(preset.id);
    names.set(nameKey, preset);
  }
  return { store: { version: INVESTIGATION_STORE_VERSION, presets: result }, added: incoming.presets.length - skipped, skipped };
}

/** @param {string} href @param {string} kind @param {unknown} values */
export function buildInvestigationShareUrl(href, kind, values) {
  /** @type {any} */
  const normalized = normalizeInvestigationValues(kind, values);
  if (typeof href !== "string" || href.length === 0) throw new TypeError("href is required");
  const url = new URL(href, "http://localhost");
  for (const key of INVESTIGATION_QUERY_KEYS) url.searchParams.delete(key);
  url.searchParams.set("investigation", kind);
  if (kind === "compare") {
    url.searchParams.set("investigationBase", normalized.base);
    url.searchParams.set("investigationTarget", normalized.target);
    url.searchParams.set("investigationMode", normalized.mode);
  } else {
    url.searchParams.set("investigationRevision", normalized.revision);
    url.searchParams.set("investigationFile", normalized.file);
    url.searchParams.set("investigationFollow", String(normalized.follow));
  }
  const isAbsolute = /^[a-z][a-z\d+.-]*:/iu.test(href);
  return isAbsolute ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
}

/** @param {string | undefined | null} search */
export function parseInvestigationUrl(search) {
  const params = new URLSearchParams(search || "");
  const namespaceKeys = Array.from(params.keys()).filter((key) => key === "investigation" || key.startsWith("investigation"));
  if (namespaceKeys.length === 0) return { kind: null, values: null, error: null, owner: null };
  const owner = params.get("investigation") === "file-history" ? "file-history" : "compare";
  const unknown = namespaceKeys.find((key) => !QUERY_KEY_SET.has(key));
  if (unknown) return { kind: null, values: null, error: `共有URLのパラメータが不明です: ${unknown}`, owner };
  const investigationValues = params.getAll("investigation");
  if (investigationValues.length !== 1 || !KIND_SET.has(investigationValues[0])) {
    return { kind: null, values: null, error: "共有URLの investigation が不正です", owner };
  }
  const kind = investigationValues[0];
  const expected = kind === "compare"
    ? ["investigationBase", "investigationTarget", "investigationMode"]
    : ["investigationRevision", "investigationFile", "investigationFollow"];
  const unexpected = INVESTIGATION_QUERY_KEYS.filter((key) => key !== "investigation" && !expected.includes(key) && params.has(key));
  if (unexpected.length > 0) return { kind: null, values: null, error: `共有URLのパラメータが対象と一致しません: ${unexpected[0]}`, owner: kind };
  /** @type {Record<string, string>} */
  const fields = {};
  for (const key of expected) {
    const all = params.getAll(key);
    if (all.length !== 1) return { kind: null, values: null, error: `共有URLの ${key} は1つだけ指定してください`, owner: kind };
    fields[key] = all[0];
  }
  /** @type {any} */
  const values = kind === "compare"
    ? { base: fields.investigationBase, target: fields.investigationTarget, mode: fields.investigationMode }
    : { revision: fields.investigationRevision, file: fields.investigationFile, follow: fields.investigationFollow };
  if (kind === "file-history") {
    if (values.follow !== "true" && values.follow !== "false") {
      return { kind: null, values: null, error: "共有URLの investigationFollow は true または false が必要です", owner: kind };
    }
    values.follow = values.follow === "true";
  }
  const validated = validateInvestigationValues(kind, values);
  if (!validated.ok) return { kind: null, values: null, error: `共有URLの入力値が不正です: ${validated.error}`, owner: kind };
  return { kind, values: validated.values, error: null, owner: kind };
}

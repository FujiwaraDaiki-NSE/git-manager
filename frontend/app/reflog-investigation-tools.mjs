/**
 * Pure helpers for the second-level, read-only reflog investigation view.
 *
 * The backend inventory order is Git's order.  This module never mutates that
 * snapshot: filtering and semantic ordering return new arrays, while record
 * identities keep two operations pointing at the same commit distinct.
 */

import {
  isValidReflogRef,
  localReflogCalendarDate,
  reflogDateRangeError,
} from "./reflog-explorer-tools.mjs";

export const UNKNOWN_REFLOG_ACTOR_FILTER = "__gitdash_unknown_reflog_actor__";
export const REFLOG_ACTOR_FILTER_PREFIX = "__gitdash_reflog_actor__:";
export const UNKNOWN_REFLOG_OPERATION_FILTER = "__gitdash_unknown_reflog_operation__";
export const REFLOG_ORDERS = Object.freeze(["git", "newest", "oldest"]);

// Keep the names short in component code while retaining explicit exported
// names for callers that need to render a filter option.
export const UNKNOWN_ACTOR_FILTER = UNKNOWN_REFLOG_ACTOR_FILTER;
export const ACTOR_FILTER_PREFIX = REFLOG_ACTOR_FILTER_PREFIX;
export const UNKNOWN_OPERATION_KIND_FILTER = UNKNOWN_REFLOG_OPERATION_FILTER;

const OPERATION_PREFIX_PATTERN = /^\s*([^:]+?)\s*:/u;

function assertRecords(records) {
  if (!Array.isArray(records)) throw new TypeError("records must be an array");
}

function assertRecord(record) {
  if (record === null || typeof record !== "object") throw new TypeError("reflog record must be provided explicitly");
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
}

function knownText(value) {
  return typeof value === "string" && value.length > 0;
}

function actorValue(record) {
  return knownText(record?.actor) ? record.actor : null;
}

function messageValue(record) {
  if (knownText(record?.message)) return record.message;
  if (knownText(record?.action)) return record.action;
  return null;
}

/** Return the operation kind from Git's message prefix, or null when unknown. */
export function reflogOperationKind(record) {
  assertRecord(record);
  const message = messageValue(record);
  if (message === null) return null;
  const match = OPERATION_PREFIX_PATTERN.exec(message);
  if (match === null) return null;
  const prefix = match[1].trim();
  if (prefix.length === 0) return null;
  // Git emits variants such as "commit (amend): ...". Keep that explicit
  // grouping while reducing command prefixes such as "merge origin/main: ..."
  // and "pull --ff-only origin main: ..." to their operation token.
  const grouped = /^(?<operation>[a-z][a-z0-9_-]*)\s+\((?<group>[^)]+)\)$/iu.exec(prefix);
  if (grouped?.groups?.operation && grouped.groups.group) {
    return `${grouped.groups.operation.toLocaleLowerCase()} (${grouped.groups.group.toLocaleLowerCase()})`;
  }
  return prefix.split(/\s+/u)[0].toLocaleLowerCase();
}

/** Return exact actor values represented by the supplied inventory. */
export function reflogActors(records) {
  assertRecords(records);
  return Array.from(new Set(records.map(actorValue).filter((value) => value !== null)))
    .sort((left, right) => left.localeCompare(right));
}

export function hasUnknownReflogActor(records) {
  assertRecords(records);
  return records.some((record) => actorValue(record) === null);
}

/** Return exact operation prefixes, retaining unknown metadata as a state. */
export function reflogOperationKinds(records) {
  assertRecords(records);
  return Array.from(new Set(records.map(reflogOperationKind).filter((value) => value !== null)))
    .sort((left, right) => left.localeCompare(right));
}

export function hasUnknownReflogOperation(records) {
  assertRecords(records);
  return records.some((record) => reflogOperationKind(record) === null);
}

function encodeFilterValue(prefix, value, label) {
  assertNonEmptyString(value, label);
  return `${prefix}${encodeURIComponent(value)}`;
}

export function encodeReflogActor(actor) {
  return encodeFilterValue(REFLOG_ACTOR_FILTER_PREFIX, actor, "actor");
}

function decodeActorFilter(value) {
  if (value === null || value === "") return { active: false, valid: true, value: null };
  if (value === UNKNOWN_REFLOG_ACTOR_FILTER) return { active: true, valid: true, value: null, unknown: true };
  if (!value.startsWith(REFLOG_ACTOR_FILTER_PREFIX)) return { active: true, valid: true, value, unknown: false };
  const encoded = value.slice(REFLOG_ACTOR_FILTER_PREFIX.length);
  if (encoded.length === 0) return { active: true, valid: false, value: null, unknown: false };
  try {
    const decoded = decodeURIComponent(encoded);
    return { active: true, valid: knownText(decoded), value: decoded, unknown: false };
  } catch {
    return { active: true, valid: false, value: null, unknown: false };
  }
}

function decodeOperationFilter(value) {
  if (value === null || value === "") return { active: false, valid: true, value: null, unknown: false };
  if (value === UNKNOWN_REFLOG_OPERATION_FILTER) return { active: true, valid: true, value: null, unknown: true };
  if (typeof value !== "string" || value.length === 0) {
    return { active: true, valid: false, value: null, unknown: false };
  }
  return { active: true, valid: true, value, unknown: false };
}

function assertFilterOptions(options) {
  if (options === null || typeof options !== "object") {
    throw new TypeError("reflog filter options must be provided explicitly");
  }
  const required = ["query", "actorFilter", "operationFilter", "startDate", "endDate"];
  if (required.some((key) => options[key] === undefined)) {
    throw new TypeError(`${required.join(", ")} must be provided explicitly; use null or an empty string for no filter`);
  }
  if (typeof options.query !== "string") throw new TypeError("query must be a string; use an empty string for no filter");
  for (const key of ["actorFilter", "operationFilter", "startDate", "endDate"]) {
    const value = options[key];
    if (value !== null && typeof value !== "string") throw new TypeError(`${key} must be a string or null`);
  }
}

function reflogTimestamp(value) {
  if (typeof value !== "string" || value.length === 0) return NaN;
  const localDate = localReflogCalendarDate(value);
  if (localDate === null) return NaN;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

/** Filter the loaded snapshot with exact actor and operation-kind conditions. */
export function filterReflogInvestigation(records, options) {
  assertRecords(records);
  assertFilterOptions(options);
  const dateError = reflogDateRangeError(options.startDate, options.endDate);
  if (dateError) return [];
  const actor = decodeActorFilter(options.actorFilter);
  const operation = decodeOperationFilter(options.operationFilter);
  if (!actor.valid || !operation.valid) return [];
  const terms = options.query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const startDate = options.startDate === null || options.startDate === "" ? null : options.startDate;
  const endDate = options.endDate === null || options.endDate === "" ? null : options.endDate;
  const dateFilterActive = startDate !== null || endDate !== null;
  return records.filter((record) => {
    if (actor.active) {
      if (actor.unknown ? actorValue(record) !== null : actorValue(record) !== actor.value) return false;
    }
    if (operation.active) {
      const kind = reflogOperationKind(record);
      if (operation.unknown ? kind !== null : kind !== operation.value) return false;
    }
    if (dateFilterActive) {
      const date = localReflogCalendarDate(record?.date);
      if (date === null) return false;
      if (startDate !== null && date < startDate) return false;
      if (endDate !== null && date > endDate) return false;
    }
    const text = [record?.action, record?.message, record?.hash, record?.actor]
      .filter((value) => typeof value === "string")
      .join("\n")
      .toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

/** A shorter alias for consumers that already have an investigation context. */
export const filterReflog = filterReflogInvestigation;

/** Return a copy in Git, newest-first, or oldest-first order. */
export function sortReflog(records, order) {
  assertRecords(records);
  if (!REFLOG_ORDERS.includes(order)) throw new RangeError(`Unknown reflog order: ${order}`);
  if (order === "git") return [...records];
  return records.map((record, index) => ({ record, index })).sort((left, right) => {
    const leftDate = reflogTimestamp(left.record?.date);
    const rightDate = reflogTimestamp(right.record?.date);
    if (!Number.isFinite(leftDate) && Number.isFinite(rightDate)) return 1;
    if (Number.isFinite(leftDate) && !Number.isFinite(rightDate)) return -1;
    if (Number.isFinite(leftDate) && Number.isFinite(rightDate) && leftDate !== rightDate) {
      return order === "oldest" ? leftDate - rightDate : rightDate - leftDate;
    }
    return left.index - right.index;
  }).map(({ record }) => record);
}

/**
 * Keep the first matching row for each destination commit in Git order.
 * Backend reflog inventories are newest-first, so the first row is the latest
 * retained operation for that hash.  The returned array is new and the input
 * records remain untouched; callers should apply semantic sorting afterward.
 */
export function latestReflogOperations(records) {
  assertRecords(records);
  const seenHashes = new Set();
  return records.filter((record) => {
    const hash = typeof record?.hash === "string" ? record.hash.toLocaleLowerCase() : null;
    if (hash === null) return true;
    if (seenHashes.has(hash)) return false;
    seenHashes.add(hash);
    return true;
  });
}

export const deduplicateReflogByHash = latestReflogOperations;

/**
 * Give every loaded row an identity independent of its commit hash.  The
 * source index is part of the identity because Git can record the same hash
 * multiple times, including at the same timestamp.
 */
export function reflogRecordIdentity(record, sourceIndex) {
  assertRecord(record);
  if (!Number.isInteger(sourceIndex) || sourceIndex < 0) {
    throw new TypeError("sourceIndex must be a non-negative integer");
  }
  if (knownText(record.recordId)) return record.recordId;
  if (knownText(record.id)) return record.id;
  return `reflog-record:${sourceIndex}:${JSON.stringify([
    record.selector ?? null,
    record.hash ?? null,
    record.date ?? null,
  ])}`;
}

export const reflogRecordId = reflogRecordIdentity;

export function withReflogRecordIdentities(records) {
  assertRecords(records);
  return records.map((record, index) => ({ ...record, recordId: reflogRecordIdentity(record, index) }));
}

/** Return adjacent rows in the supplied visible order; never wraps. */
export function adjacentReflogRecords(records, selectedRecordId) {
  assertRecords(records);
  if (selectedRecordId === undefined) throw new TypeError("selectedRecordId must be provided explicitly; use null for no selection");
  if (selectedRecordId !== null && typeof selectedRecordId !== "string") throw new TypeError("selectedRecordId must be a string or null");
  const index = selectedRecordId === null
    ? -1
    : records.findIndex((record, sourceIndex) => reflogRecordIdentity(record, sourceIndex) === selectedRecordId);
  return {
    index,
    count: records.length,
    previous: index > 0 ? records[index - 1] : null,
    next: index >= 0 && index + 1 < records.length ? records[index + 1] : null,
  };
}

function markdownValue(value) {
  if (value === null || value === undefined || value === "") return "未取得";
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/[\\`*_{}\[\]()#+.!|~]/g, "\\$&")
    .replace(/\r\n|\r|\n/g, "<br>");
}

/** Build an escaped Markdown handoff report for one selected operation. */
export function reflogInvestigationMarkdown(record, path, ref) {
  assertRecord(record);
  assertNonEmptyString(path, "repository path");
  if (!isValidReflogRef(ref)) throw new TypeError("ref must be an explicit HEAD or full reflog ref");
  const kind = reflogOperationKind(record);
  return [
    "# gitdash reflog operation investigation",
    "",
    "## operation",
    "",
    `- repository_path: ${markdownValue(path)}`,
    `- ref: ${markdownValue(ref)}`,
    `- record_id: ${markdownValue(record.recordId ?? record.id)}`,
    `- selector: ${markdownValue(record.selector)}`,
    `- immutable_hash: ${markdownValue(record.hash)}`,
    `- operation_kind: ${markdownValue(kind)}`,
    `- message: ${markdownValue(messageValue(record))}`,
    `- actor: ${markdownValue(record.actor)}`,
    `- date: ${markdownValue(record.date)}`,
    "- read_only: true",
  ].join("\n");
}

function jsonRecord(record, index) {
  assertRecord(record);
  return {
    record_id: reflogRecordIdentity(record, index),
    hash: record.hash ?? null,
    selector: record.selector ?? null,
    message: record.message ?? record.action ?? null,
    operation_kind: reflogOperationKind(record),
    actor: record.actor ?? null,
    date: record.date ?? null,
  };
}

/**
 * Serialize exactly the filtered records together with the selected ref's
 * authoritative inventory metadata.  All metadata fields are explicit so a
 * missing value is not silently replaced by another inventory's value.
 */
export function reflogFilteredJson({ path, ref, records, available, truncated }) {
  assertNonEmptyString(path, "repository path");
  if (!isValidReflogRef(ref)) throw new TypeError("ref must be an explicit HEAD or full reflog ref");
  assertRecords(records);
  if (typeof available !== "boolean" || typeof truncated !== "boolean") {
    throw new TypeError("available and truncated must be provided as booleans");
  }
  return `${JSON.stringify({
    repository_path: path,
    ref,
    available,
    truncated,
    record_count: records.length,
    records: records.map(jsonRecord),
    read_only: true,
  }, null, 2)}\n`;
}

export const reflogInventoryJson = reflogFilteredJson;
export const reflogJson = reflogFilteredJson;

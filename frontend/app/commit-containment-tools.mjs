// @ts-check

/** Pure helpers for the read-only commit containment explorer. */

import { buildInvestigationShareUrl } from "./investigation-presets-tools.mjs";

export const CONTAINMENT_TYPES = ["all", "local", "remote", "tag"];
export const CONTAINMENT_FILTER_TYPES = CONTAINMENT_TYPES;
export const CONTAINMENT_ORDERS = ["git", "name", "type"];
const HASH_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const REVISION_OPERATOR_PATTERN = /\.\.|~|\^|:|@\{/u;
const REVISION_REF_DISALLOWED_PATTERN = /[\x00-\x20\x7f~^:?*\[\\]/u;

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Return the complete client-owned initial state for one repository.
 * Nothing is fetched until the caller supplies a revision and submits it.
 * @param {{path: string}} input
 */
export function defaultCommitContainment(input) {
  if (!isRecord(input) || typeof input.path !== "string" || input.path.length === 0) {
    throw new TypeError("path is required");
  }
  return { path: input.path, revision: "", query: "", type: "all" };
}

/** @param {unknown} value */
export function isContainmentHash(value) {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

/** Return whether a revision is an explicit hash, HEAD, or ref candidate. */
/** @param {unknown} value */
export function isValidContainmentRevision(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.startsWith("-")) return false;
  if (isContainmentHash(value) || value === "HEAD") return true;
  if (/\s/u.test(value)) return false;
  if (REVISION_OPERATOR_PATTERN.test(value) || REVISION_REF_DISALLOWED_PATTERN.test(value)) return false;
  if (value.startsWith("/") || value.endsWith("/") || value.endsWith(".") || value.includes("..")) return false;
  const parts = value.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== ".." && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock"));
}

/** @param {unknown} value */
export function normalizeContainmentType(value) {
  if (typeof value !== "string" || !CONTAINMENT_TYPES.includes(value)) {
    throw new RangeError(`Unknown containment type: ${String(value)}`);
  }
  return value;
}

/** Build the only inventory request; the selected revision is mandatory. */
/** @param {string} path @param {string} revision */
export function containmentRequestQuery(path, revision) {
  if (typeof path !== "string" || path.length === 0) throw new TypeError("path is required");
  if (typeof revision !== "string" || revision.trim().length === 0) {
    throw new TypeError("revision must be provided explicitly");
  }
  return new URLSearchParams({ path, revision: revision.trim() }).toString();
}

/** @param {unknown} query */
function normalizedTerms(query) {
  return (typeof query === "string" ? query : "")
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/u)
    .filter(Boolean);
}

/**
 * Filter only the already-retrieved snapshot.  The type selector is an exact
 * enum filter; the name field is an AND search over ref and display name.
 * @param {Array<{ref: string, type: string, object_hash?: string, peeled_commit?: string}>} refs
 * @param {string} query
 * @param {string} type
 */
export function filterContainmentRefs(refs, query, type) {
  if (!Array.isArray(refs)) throw new TypeError("refs must be an array");
  if (query === undefined || type === undefined) {
    throw new TypeError("query and type must be provided explicitly");
  }
  normalizeContainmentType(type);
  const terms = normalizedTerms(query);
  return refs.filter((item) => {
    if (!isRecord(item) || typeof item.ref !== "string" || typeof item.type !== "string") return false;
    if (type !== "all" && item.type !== type) return false;
    const text = [item.ref, containmentRefDisplayName(item.ref), item.type].join("\n").toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

/** @param {string} ref */
export function containmentRefDisplayName(ref) {
  if (typeof ref !== "string") throw new TypeError("ref must be a string");
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  if (ref.startsWith("refs/remotes/")) return ref.slice("refs/remotes/".length);
  if (ref.startsWith("refs/tags/")) return ref.slice("refs/tags/".length);
  return ref;
}

/** @param {string} type */
export function containmentTypeLabel(type) {
  if (type === "all") return "すべて";
  if (type === "local") return "local";
  if (type === "remote") return "remote";
  if (type === "tag") return "tag";
  throw new RangeError(`Unknown containment type: ${String(type)}`);
}

/** @typedef {{ref: string, type: string, object_hash: string, peeled_commit: string}} ContainmentRef */
/** @typedef {{revision: string, pinned_hash: string, observed_at: number, truncated: boolean, record_limit: number, byte_limit: number}} ContainmentSnapshot */

/** Return the first namespace component of an exact remote-tracking ref. */
/** @param {{ref: string, type: string}} item */
export function containmentRemoteNamespace(item) {
  if (item.type !== "remote" || !item.ref.startsWith("refs/remotes/")) return null;
  const suffix = item.ref.slice("refs/remotes/".length);
  const separator = suffix.indexOf("/");
  return separator > 0 && separator < suffix.length - 1 ? suffix.slice(0, separator) : null;
}

/** @param {string} left @param {string} right */
function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** @param {ContainmentRef[]} refs */
export function containmentRemoteNamespaces(refs) {
  if (!Array.isArray(refs)) throw new TypeError("refs must be an array");
  return [...new Set(refs.map(containmentRemoteNamespace).filter((name) => name !== null))].sort(compareText);
}

/** null explicitly means no remote namespace restriction. */
/** @template {ContainmentRef} T @param {T[]} refs @param {string | null} remote */
export function filterContainmentRemoteRefs(refs, remote) {
  if (!Array.isArray(refs)) throw new TypeError("refs must be an array");
  if (remote !== null && (typeof remote !== "string" || remote.length === 0)) {
    throw new TypeError("remote must be a namespace or explicit null");
  }
  return refs.filter((item) => remote === null || containmentRemoteNamespace(item) === remote);
}

/** @param {unknown} order */
function validateContainmentOrder(order) {
  if (typeof order !== "string" || !CONTAINMENT_ORDERS.includes(order)) throw new RangeError("Unknown containment order");
}

/** Git order preserves the API snapshot; other orders use the full ref as a stable tie-breaker. */
/** @template {ContainmentRef} T @param {T[]} refs @param {string} order */
export function sortContainmentRefs(refs, order) {
  if (!Array.isArray(refs)) throw new TypeError("refs must be an array");
  validateContainmentOrder(order);
  const result = [...refs];
  if (order === "git") return result;
  return result.sort((left, right) => {
    if (order === "type") {
      const typeOrder = CONTAINMENT_TYPES.indexOf(left.type) - CONTAINMENT_TYPES.indexOf(right.type);
      if (typeOrder !== 0) return typeOrder;
    }
    return compareText(containmentRefDisplayName(left.ref), containmentRefDisplayName(right.ref))
      || compareText(left.ref, right.ref);
  });
}

/** Keep the first displayed target order and collect refs pointing at the same peeled commit. */
/** @template {ContainmentRef} T @param {T[]} refs */
export function groupContainmentRefs(refs) {
  if (!Array.isArray(refs)) throw new TypeError("refs must be an array");
  /** @type {Map<string, {peeled_commit: string, refs: T[]}>} */
  const groups = new Map();
  for (const item of refs) {
    const key = item.peeled_commit.toLowerCase();
    const group = groups.get(key);
    if (group) group.refs.push(item);
    else groups.set(key, { peeled_commit: item.peeled_commit, refs: [item] });
  }
  return [...groups.values()];
}

/** A selection outside the visible set has no adjacent visible ref; callers offer an explicit first-ref action. */
/** @param {ContainmentRef[]} refs @param {string | null} selectedRef */
export function containmentRefNavigation(refs, selectedRef) {
  if (!Array.isArray(refs)) throw new TypeError("refs must be an array");
  if (selectedRef !== null && typeof selectedRef !== "string") throw new TypeError("selectedRef must be a string or explicit null");
  const index = selectedRef === null ? -1 : refs.findIndex((item) => item.ref === selectedRef);
  return {
    position: index < 0 ? null : index + 1,
    total: refs.length,
    previous: index > 0 ? refs[index - 1].ref : null,
    next: index >= 0 && index < refs.length - 1 ? refs[index + 1].ref : null,
    first: refs.length === 0 ? null : refs[0].ref,
  };
}

/** @param {ContainmentSnapshot} snapshot */
function validateContainmentSnapshot(snapshot) {
  if (!isRecord(snapshot) || typeof snapshot.revision !== "string" || !isContainmentHash(snapshot.pinned_hash)
    || typeof snapshot.observed_at !== "number" || !Number.isFinite(snapshot.observed_at)
    || typeof snapshot.truncated !== "boolean" || !Number.isInteger(snapshot.record_limit) || snapshot.record_limit < 1
    || !Number.isInteger(snapshot.byte_limit) || snapshot.byte_limit < 1) {
    throw new TypeError("complete snapshot metadata is required");
  }
}

/** Export the displayed refs with their original snapshot coverage and explicit view conditions. */
/**
 * @param {ContainmentRef[]} refs
 * @param {ContainmentSnapshot} snapshot
 * @param {{path: string, query: string, type: string, remote: string | null, order: string, grouped: boolean}} view
 */
export function buildContainmentJson(refs, snapshot, view) {
  if (!Array.isArray(refs)) throw new TypeError("refs must be an array");
  validateContainmentSnapshot(snapshot);
  if (!isRecord(view) || typeof view.path !== "string" || view.path.length === 0 || typeof view.query !== "string"
    || typeof view.grouped !== "boolean" || (view.remote !== null && (typeof view.remote !== "string" || view.remote.length === 0))) {
    throw new TypeError("complete view conditions are required");
  }
  normalizeContainmentType(view.type);
  validateContainmentOrder(view.order);
  return JSON.stringify({
    schema_version: 1,
    path: view.path,
    revision: snapshot.revision,
    pinned_hash: snapshot.pinned_hash,
    observed_at: snapshot.observed_at,
    truncated: snapshot.truncated,
    record_limit: snapshot.record_limit,
    byte_limit: snapshot.byte_limit,
    filters: { query: view.query, type: view.type, remote: view.remote },
    order: view.order,
    grouped: view.grouped,
    refs: refs.map(({ ref, type, object_hash, peeled_commit }) => ({ ref, type, object_hash, peeled_commit })),
  }, null, 2) + "\n";
}

/** @param {string} value */
function markdownCode(value) {
  const runs = value.match(/`+/gu);
  const delimiter = "`".repeat(runs === null ? 1 : Math.max(...runs.map((run) => run.length)) + 1);
  const padding = /^[` ]|[` ]$/u.test(value) ? " " : "";
  return `${delimiter}${padding}${value}${padding}${delimiter}`;
}

/** @param {string} path @param {ContainmentRef} item @param {ContainmentSnapshot} snapshot */
export function buildContainmentRefMarkdown(path, item, snapshot) {
  if (typeof path !== "string" || path.length === 0) throw new TypeError("path is required");
  validateContainmentSnapshot(snapshot);
  if (!isRecord(item) || typeof item.ref !== "string" || !isContainmentHash(item.object_hash) || !isContainmentHash(item.peeled_commit)) {
    throw new TypeError("a complete selected ref is required");
  }
  return [
    "# コミットを含む参照の調査",
    "",
    `- リポジトリ: ${markdownCode(path)}`,
    `- 調査revision: ${markdownCode(snapshot.revision)}`,
    `- 固定コミット: ${markdownCode(snapshot.pinned_hash)}`,
    `- 観測日時 (UTC): ${new Date(snapshot.observed_at * 1000).toISOString()}`,
    `- 取得範囲: ${snapshot.truncated ? "上限に達したため一部の参照のみ" : "取得上限内の全参照"}`,
    "",
    "## 選択した参照",
    "",
    `- 参照: ${markdownCode(item.ref)}`,
    `- 種類: ${containmentTypeLabel(item.type)}`,
    `- ref object: ${markdownCode(item.object_hash)}`,
    `- 固定先コミット: ${markdownCode(item.peeled_commit)}`,
    "",
  ].join("\n");
}

/** Map each displayed full ref to its complete peeled commit, including annotated tags. */
/** @param {ContainmentRef[]} refs */
export function buildContainmentRefMapping(refs) {
  if (!Array.isArray(refs)) throw new TypeError("refs must be an array");
  return JSON.stringify(Object.fromEntries(refs.map((item) => [item.ref, item.peeled_commit])), null, 2) + "\n";
}

/** @param {unknown} value */
function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  // Protect values with leading whitespace/BOM as well as direct operators;
  // spreadsheet programs may skip the whitespace and still evaluate a cell.
  const safe = /^[\s\uFEFF]*[=+\-@]/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

/**
 * Export exactly the matching refs from one immutable inventory snapshot.
 * @param {Array<{ref: string, type: string, object_hash: string, peeled_commit: string}>} refs
 * @param {{pinned_hash: string, observed_at: number}} snapshot
 */
export function buildContainmentCsv(refs, snapshot) {
  if (!Array.isArray(refs)) throw new TypeError("refs must be an array");
  if (!isRecord(snapshot) || !isContainmentHash(snapshot.pinned_hash) || typeof snapshot.observed_at !== "number" || !Number.isFinite(snapshot.observed_at)) {
    throw new TypeError("snapshot must include pinned_hash and observed_at");
  }
  const rows = [
    ["pinned_hash", "observed_at", "ref", "type", "object_hash", "peeled_commit"],
    ...refs.map((item) => [snapshot.pinned_hash, snapshot.observed_at, item.ref, item.type, item.object_hash, item.peeled_commit]),
  ];
  return "\uFEFF" + `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export const containmentCsv = buildContainmentCsv;

/**
 * Create a compare URL that fills the existing compare form without running
 * it.  The investigated commit is base and the immutable ref tip is target.
 * @param {string} href
 * @param {string} pinnedHash
 * @param {string} targetHash
 */
export function buildContainmentCompareUrl(href, pinnedHash, targetHash) {
  if (typeof href !== "string" || href.length === 0) throw new TypeError("href is required");
  if (!isContainmentHash(pinnedHash) || !isContainmentHash(targetHash)) {
    throw new TypeError("compare hashes must be complete commit hashes");
  }
  return buildInvestigationShareUrl(href, "compare", {
    base: pinnedHash,
    target: targetHash,
    mode: "direct",
  });
}

/** A stable identity for one path + pinned inventory snapshot. */
/** @param {string} path @param {{pinned_hash: string, observed_at: number}} snapshot */
export function containmentSnapshotKey(path, snapshot) {
  if (typeof path !== "string" || path.length === 0) throw new TypeError("path is required");
  if (!isRecord(snapshot) || !isContainmentHash(snapshot.pinned_hash) || typeof snapshot.observed_at !== "number" || !Number.isFinite(snapshot.observed_at)) {
    throw new TypeError("snapshot must include pinned_hash and observed_at");
  }
  return `${path}\u0000${snapshot.pinned_hash.toLowerCase()}\u0000${snapshot.observed_at}`;
}

/** @param {string} path @param {string} ref */
export function containmentCommand(path, ref) {
  if (typeof path !== "string" || path.length === 0 || typeof ref !== "string" || ref.length === 0) return null;
  /** @param {string} value */
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  return `git -C ${quote(path)} for-each-ref --contains=<pinned-commit> ${quote(ref)}`;
}

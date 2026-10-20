// @ts-check

/** Pure helpers for the read-only commit containment explorer. */

import { buildInvestigationShareUrl } from "./investigation-presets-tools.mjs";

export const CONTAINMENT_TYPES = ["all", "local", "remote", "tag"];
export const CONTAINMENT_FILTER_TYPES = CONTAINMENT_TYPES;
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

import {
  filterTags,
  searchTags,
  sortTags,
  tagCreatorIdentity,
} from "./tag-explorer-tools.mjs";

/** Pure client-side view helpers for the already retrieved tag snapshot. */

export const UNKNOWN_TAG_CREATOR_FILTER = "__gitdash_unknown_tag_creator__";
export const TAG_CREATOR_FILTER_PREFIX = "__gitdash_tag_creator__:";
export const UNKNOWN_TAG_OBJECT_TYPE_FILTER = "__gitdash_unknown_tag_object_type__";

export const TAG_OBJECT_TYPES = Object.freeze(["commit", "tree", "blob", "tag"]);

export const TAG_CREATOR_DATE_ALL = "all";
export const TAG_CREATOR_DATE_KNOWN = "known";
export const TAG_CREATOR_DATE_UNKNOWN = "unknown";
export const TAG_CREATOR_DATE_FILTERS = Object.freeze([
  TAG_CREATOR_DATE_ALL,
  TAG_CREATOR_DATE_KNOWN,
  TAG_CREATOR_DATE_UNKNOWN,
]);

const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

function assertTags(tags) {
  if (!Array.isArray(tags)) throw new TypeError("tags must be an array");
}

function isEmpty(value) {
  return value === null || value === undefined || value === "";
}

function daysInMonth(year, month) {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Return an exact YYYY-MM-DD value when it is a real calendar date. */
export function parseTagCalendarDate(value) {
  if (isEmpty(value) || typeof value !== "string") return null;
  const match = CALENDAR_DATE_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return value;
}

/** Explain malformed or reversed inclusive local-calendar boundaries. */
export function tagCreatorDateRangeError(startDate, endDate) {
  if (startDate === undefined || endDate === undefined) {
    throw new TypeError("startDate and endDate must be provided explicitly; use null or an empty string for no filter");
  }
  const start = parseTagCalendarDate(startDate);
  const end = parseTagCalendarDate(endDate);
  if (!isEmpty(startDate) && start === null) return "開始日は有効な日付（YYYY-MM-DD）で指定してください。";
  if (!isEmpty(endDate) && end === null) return "終了日は有効な日付（YYYY-MM-DD）で指定してください。";
  if (start !== null && end !== null && start > end) return "開始日は終了日以前の日付にしてください。";
  return null;
}

function tagTimestamp(value) {
  if (typeof value !== "string" || value.length === 0) return NaN;
  // Validate the source calendar component before Date.parse so malformed
  // Git dates cannot be normalized into a different local day.
  if (parseTagCalendarDate(value.slice(0, 10)) === null) return NaN;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

/** Convert a Git creator instant into the browser's local calendar date. */
export function localTagCreatorCalendarDate(value) {
  const timestamp = tagTimestamp(value);
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function assertFilterOptions(options) {
  if (options === null || typeof options !== "object") {
    throw new TypeError("tag filter options must be provided explicitly");
  }
  const required = ["query", "type", "creatorFilter", "objectType", "startDate", "endDate", "datePresence", "sort", "collapseTargets"];
  if (required.some((key) => options[key] === undefined)) {
    throw new TypeError(`${required.join(", ")} must be provided explicitly; use null or an empty string for no filter`);
  }
  if (typeof options.query !== "string") throw new TypeError("query must be a string; use an empty string for no filter");
  if (options.creatorFilter !== null && typeof options.creatorFilter !== "string") {
    throw new TypeError("creatorFilter must be a string or null; use an empty string for no filter");
  }
  if (options.objectType !== null && typeof options.objectType !== "string") {
    throw new TypeError("objectType must be a string or null; use an empty string for no filter");
  }
  if (options.startDate !== null && typeof options.startDate !== "string") throw new TypeError("startDate must be a string or null");
  if (options.endDate !== null && typeof options.endDate !== "string") throw new TypeError("endDate must be a string or null");
  if (typeof options.datePresence !== "string") throw new TypeError("datePresence must be provided explicitly");
  if (typeof options.sort !== "string") throw new TypeError("sort must be provided explicitly");
  if (typeof options.collapseTargets !== "boolean") throw new TypeError("collapseTargets must be provided explicitly");
}

function hasKnownCreator(tag) {
  return tagCreatorIdentity(tag?.creator) !== null;
}

/** Return exact creator identities, excluding the explicit unknown bucket. */
export function tagCreatorIdentities(tags) {
  assertTags(tags);
  return Array.from(new Set(tags.filter(hasKnownCreator).map((tag) => tagCreatorIdentity(tag.creator))))
    .sort((left, right) => left.localeCompare(right, "ja", { sensitivity: "base" }));
}

/** Whether the inventory contains at least one missing creator identity. */
export function hasUnknownTagCreator(tags) {
  assertTags(tags);
  return tags.some((tag) => !hasKnownCreator(tag));
}

/** Encode a known identity so it cannot collide with the explicit unknown token. */
export function encodeTagCreatorFilter(identity) {
  if (typeof identity !== "string" || identity.length === 0) {
    throw new TypeError("identity must be a non-empty string");
  }
  return `${TAG_CREATOR_FILTER_PREFIX}${encodeURIComponent(identity)}`;
}

function decodeCreatorFilter(value) {
  if (typeof value !== "string" || !value.startsWith(TAG_CREATOR_FILTER_PREFIX)) {
    return { valid: true, value };
  }
  const encoded = value.slice(TAG_CREATOR_FILTER_PREFIX.length);
  if (encoded.length === 0) return { valid: false, value: null };
  try {
    const decoded = decodeURIComponent(encoded);
    return { valid: decoded.length > 0, value: decoded };
  } catch {
    return { valid: false, value: null };
  }
}

function matchesCreator(tag, selected) {
  if (selected === null || selected === "") return true;
  if (selected === UNKNOWN_TAG_CREATOR_FILTER) return !hasKnownCreator(tag);
  const decoded = decodeCreatorFilter(selected);
  if (!decoded.valid) return false;
  return hasKnownCreator(tag) && tagCreatorIdentity(tag.creator) === decoded.value;
}

function matchesObjectType(tag, selected) {
  if (selected === null || selected === "") return true;
  if (selected === UNKNOWN_TAG_OBJECT_TYPE_FILTER) {
    return typeof tag?.peeled_type !== "string" || tag.peeled_type.length === 0;
  }
  if (!TAG_OBJECT_TYPES.includes(selected)) return false;
  return tag?.peeled_type === selected;
}

function matchesCreatorDate(tag, startDate, endDate, presence) {
  const date = localTagCreatorCalendarDate(tag?.creator_date);
  if (presence === TAG_CREATOR_DATE_UNKNOWN) return date === null;
  if (presence === TAG_CREATOR_DATE_KNOWN && date === null) return false;
  if (presence !== TAG_CREATOR_DATE_ALL && presence !== TAG_CREATOR_DATE_KNOWN) return false;
  if (startDate === null && endDate === null) return true;
  if (date === null) return false;
  if (startDate !== null && date < startDate) return false;
  if (endDate !== null && date > endDate) return false;
  return true;
}

function isKnownDatePresence(value) {
  return TAG_CREATOR_DATE_FILTERS.includes(value);
}

/** Apply every explicit client-side tag condition and preserve sorted order. */
export function filterTagInvestigation(tags, options) {
  assertTags(tags);
  assertFilterOptions(options);
  const dateError = tagCreatorDateRangeError(options.startDate, options.endDate);
  if (dateError || !isKnownDatePresence(options.datePresence)) return [];
  if (options.datePresence === TAG_CREATOR_DATE_UNKNOWN && (!isEmpty(options.startDate) || !isEmpty(options.endDate))) {
    // Unknown-date selection and a finite calendar range are contradictory;
    // do not silently discard the explicit range.
    return [];
  }
  // The empty string is the explicit empty value accepted by date inputs and
  // is normalized only for the comparison below; null remains the exported
  // empty value in filter metadata.
  const startDate = isEmpty(options.startDate) ? null : options.startDate;
  const endDate = isEmpty(options.endDate) ? null : options.endDate;
  const searched = searchTags(tags, options.query);
  const typed = filterTags(searched, options.type);
  const filtered = typed.filter((tag) => (
    matchesCreator(tag, options.creatorFilter)
    && matchesObjectType(tag, options.objectType)
    && matchesCreatorDate(tag, startDate, endDate, options.datePresence)
  ));
  return sortTags(filtered, options.sort);
}

/** Return the exact target-object key used for collapse, or null when unknown. */
export function tagTargetKey(tag) {
  if (typeof tag?.peeled_hash !== "string" || tag.peeled_hash.length === 0) return null;
  if (typeof tag?.peeled_type !== "string" || tag.peeled_type.length === 0) return null;
  return `${tag.peeled_type}\u0000${tag.peeled_hash}`;
}

/** Count rows that point to exactly the same known target object. */
export function tagTargetGroupSize(tags, tag) {
  assertTags(tags);
  if (tag === null || typeof tag !== "object") throw new TypeError("tag must be provided explicitly");
  const key = tagTargetKey(tag);
  if (key === null) return 1;
  return tags.filter((candidate) => tagTargetKey(candidate) === key).length;
}

/** Keep the first row for each exact target object, preserving visible order. */
export function collapseTagTargets(tags, collapseTargets) {
  assertTags(tags);
  if (typeof collapseTargets !== "boolean") throw new TypeError("collapseTargets must be provided explicitly");
  if (!collapseTargets) return [...tags];
  const seen = new Set();
  return tags.filter((tag) => {
    const key = tagTargetKey(tag);
    if (key === null) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Explain whether the selected tag is visible, collapsed, or filtered out. */
export function tagSelectionVisibility(filteredTags, visibleTags, selectedName) {
  assertTags(filteredTags);
  assertTags(visibleTags);
  if (selectedName === undefined) throw new TypeError("selectedName must be provided explicitly; use null for no selection");
  if (selectedName !== null && typeof selectedName !== "string") throw new TypeError("selectedName must be a string or null");
  if (selectedName === null) return "none";
  if (visibleTags.some((tag) => tag?.name === selectedName)) return "visible";
  if (filteredTags.some((tag) => tag?.name === selectedName)) return "collapsed";
  return "filtered";
}

/** Return adjacent rows in the supplied visible order; never wrap or infer. */
export function adjacentTags(tags, selectedName) {
  assertTags(tags);
  if (selectedName === undefined) throw new TypeError("selectedName must be provided explicitly; use null for no selection");
  if (selectedName !== null && typeof selectedName !== "string") throw new TypeError("selectedName must be a string or null");
  const index = selectedName === null ? -1 : tags.findIndex((tag) => tag?.name === selectedName);
  return {
    index,
    count: tags.length,
    previous: index > 0 ? tags[index - 1] : null,
    next: index >= 0 && index + 1 < tags.length ? tags[index + 1] : null,
  };
}

function assertExportFilters(filters) {
  assertFilterOptions(filters);
  return {
    query: filters.query,
    type: filters.type,
    creator: filters.creatorFilter,
    target_object_type: filters.objectType,
    creator_date_presence: filters.datePresence,
    creator_date_start: filters.startDate,
    creator_date_end: filters.endDate,
    sort: filters.sort,
    collapse_same_target: filters.collapseTargets,
  };
}

/** Serialize exactly the already filtered/collapsed tags with repository/filter metadata. */
export function tagsJson(tags, metadata) {
  assertTags(tags);
  if (metadata === null || typeof metadata !== "object") throw new TypeError("tag export metadata must be provided explicitly");
  if (typeof metadata.repositoryPath !== "string" || metadata.repositoryPath.length === 0) {
    throw new TypeError("repositoryPath must be a non-empty string");
  }
  if (metadata.filters === null || typeof metadata.filters !== "object") {
    throw new TypeError("filters must be provided explicitly");
  }
  const filters = assertExportFilters(metadata.filters);
  return `${JSON.stringify({
    repository_path: metadata.repositoryPath,
    filters,
    count: tags.length,
    tags,
  }, null, 2)}\n`;
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

function markdownExactValue(value) {
  if (value === null || value === undefined || value === "") return "未取得";
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replace(/\r\n|\r|\n/g, "<br>");
}

function booleanValue(value) {
  return value === true ? "true" : value === false ? "false" : "unknown";
}

function reportFence(value) {
  const runs = String(value).match(/`+/g) ?? [];
  const length = Math.max(3, ...runs.map((run) => run.length + 1));
  return "`".repeat(length);
}

function assertTagDetail(detail) {
  if (detail === null || typeof detail !== "object") throw new TypeError("tag detail must be provided explicitly");
  const required = ["name", "type", "hash", "peeled_hash", "peeled_type", "creator", "creator_date", "annotation"];
  if (required.some((key) => detail[key] === undefined)) throw new TypeError(`${required.join(", ")} must be provided explicitly`);
  if (typeof detail.annotation !== "object" && detail.annotation !== null) throw new TypeError("annotation must be an object or null");
  if (detail.annotation !== null) {
    const annotationRequired = ["object_hash", "object_type", "tag", "tagger", "tagger_date", "message", "message_truncated"];
    if (annotationRequired.some((key) => detail.annotation[key] === undefined)) {
      throw new TypeError(`${annotationRequired.join(", ")} must be provided explicitly on annotation`);
    }
    if (typeof detail.annotation.message !== "string") throw new TypeError("annotation.message must be a string");
    if (typeof detail.annotation.message_truncated !== "boolean") throw new TypeError("annotation.message_truncated must be a boolean");
  }
}

function assertTargetCommit(commit) {
  if (commit === null) return;
  if (typeof commit !== "object") throw new TypeError("targetCommit must be an object or null");
  const required = ["hash", "subject", "author", "date"];
  if (required.some((key) => commit[key] === undefined)) throw new TypeError(`${required.join(", ")} must be provided explicitly on targetCommit`);
}

/** Build a complete selected-tag handoff report from explicit detail data. */
export function tagInvestigationMarkdown(detail, repositoryPath, targetCommit) {
  assertTagDetail(detail);
  if (typeof repositoryPath !== "string" || repositoryPath.length === 0) throw new TypeError("repositoryPath must be a non-empty string");
  if (targetCommit === undefined) throw new TypeError("targetCommit must be provided explicitly; use null when unavailable");
  assertTargetCommit(targetCommit);
  const annotation = detail.annotation;
  const message = annotation === null ? "" : annotation.message;
  const fence = reportFence(message);
  return [
    "# gitdash tag investigation",
    "",
    "## repository",
    "",
    `- repository_path: ${markdownValue(repositoryPath)}`,
    "- read_only: true",
    "",
    "## tag",
    "",
    `- name: ${markdownValue(detail.name)}`,
    `- type: ${markdownExactValue(detail.type)}`,
    `- tag_object_hash: ${markdownExactValue(detail.hash)}`,
    `- creator: ${markdownValue(tagCreatorIdentity(detail.creator))}`,
    `- creator_date: ${markdownExactValue(detail.creator_date)}`,
    `- target_hash: ${markdownExactValue(detail.peeled_hash)}`,
    `- target_type: ${markdownExactValue(detail.peeled_type)}`,
    "",
    "## annotation",
    "",
    `- present: ${annotation === null ? "false" : "true"}`,
    `- tag: ${markdownValue(annotation?.tag)}`,
    `- tagger: ${markdownValue(annotation?.tagger)}`,
    `- tagger_date: ${markdownExactValue(annotation?.tagger_date)}`,
    `- object_hash: ${markdownExactValue(annotation?.object_hash)}`,
    `- object_type: ${markdownExactValue(annotation?.object_type)}`,
    `- message_truncated: ${booleanValue(annotation === null ? null : annotation.message_truncated)}`,
    "",
    "### message",
    "",
    `${fence}text`,
    message,
    fence,
    "",
    "## target commit",
    "",
    `- loaded: ${targetCommit === null ? "false" : "true"}`,
    `- hash: ${markdownExactValue(targetCommit?.hash)}`,
    `- subject: ${markdownValue(targetCommit?.subject)}`,
    `- author: ${markdownValue(targetCommit?.author)}`,
    `- date: ${markdownExactValue(targetCommit?.date)}`,
    "",
    "- read_only: true",
  ].join("\n");
}

